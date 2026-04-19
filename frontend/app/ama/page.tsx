'use client'

import React, { useEffect, useRef, useState } from 'react'
import { type UIMessage, useChat } from '@ai-sdk/react'
import { Navbar } from '@/components/navbar'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { DEEPGRAM_STREAM_SAMPLE_RATE, PcmAudioPlayer, StreamingTextChunker } from '@/lib/ama-voice'
import { useToast } from '@/hooks/use-toast'

const INITIAL_ASSISTANT_MESSAGE = 'segov@terminal:~$ ./ama \nAsk me anything about Jonathan.'
const INITIAL_MESSAGE_ID = 'initial'
const AMA_INPUT_ID = 'ama-input'
const AMA_TRANSCRIPT_ID = 'ama-transcript'
const AMA_VOICE_MODE_ID = 'ama-voice-mode'
const AMA_VOICE_MODE_STORAGE_KEY = 'ama-voice-mode-enabled'
const VOICE_SOCKET_MAX_AGE_MS = 50 * 60 * 1000

const API_ERROR_TOAST = {
  title: 'API Error',
  description: 'Failed to get a response from the API. Please try again later.',
  variant: 'destructive' as const,
}

const VOICE_ERROR_TOAST = {
  title: 'Voice Error',
  description: 'Failed to start live voice mode. Please try again later.',
  variant: 'destructive' as const,
}

const INITIAL_MESSAGES: UIMessage[] = [
  {
    id: INITIAL_MESSAGE_ID,
    role: 'assistant',
    parts: [{ type: 'text', text: INITIAL_ASSISTANT_MESSAGE }],
  },
]

const VOICE_RUNTIME_LABELS = {
  connecting: 'Connecting',
  error: 'Error',
  speaking: 'Speaking',
  stopped: 'Stopped',
} as const

type VoiceRuntimeStatus = keyof typeof VOICE_RUNTIME_LABELS

type VoiceTokenResponse = {
  accessToken: string
  expiresIn: number
  model: string
  encoding: string
  sampleRate: number
}

type DeepgramVoiceMessage =
  | { type: 'Speak'; text: string }
  | { type: 'Flush' }
  | { type: 'Clear' }
  | { type: 'Close' }

function getMessageText(parts: UIMessage['parts']): string {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

function getBrowserAudioContextConstructor() {
  if (typeof window === 'undefined') {
    return null
  }

  const browserWindow = window as Window &
    typeof globalThis & {
      webkitAudioContext?: typeof AudioContext
    }

  return browserWindow.AudioContext ?? browserWindow.webkitAudioContext ?? null
}

export default function AMAPage() {
  const [input, setInput] = useState('')
  const [voiceModeEnabled, setVoiceModeEnabled] = useState(false)
  const [voiceRuntimeStatus, setVoiceRuntimeStatus] = useState<VoiceRuntimeStatus>('stopped')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const isMountedRef = useRef(true)
  const audioContextRef = useRef<AudioContext | null>(null)
  const voicePlayerRef = useRef<PcmAudioPlayer | null>(null)
  const voiceSocketRef = useRef<WebSocket | null>(null)
  const voiceSocketOpenPromiseRef = useRef<Promise<boolean> | null>(null)
  const voiceSocketConnectedAtRef = useRef<number | null>(null)
  const voiceSocketClosedIntentionallyRef = useRef(false)
  const voiceTokenAbortControllerRef = useRef<AbortController | null>(null)
  const voiceModeEnabledRef = useRef(false)
  const voiceRuntimeStatusRef = useRef<VoiceRuntimeStatus>('stopped')
  const activeAssistantMessageIdRef = useRef<string | null>(null)
  const activeAssistantTextLengthRef = useRef(0)
  const activeVoiceTurnFinalizedRef = useRef(false)
  const suppressedAssistantMessageIdRef = useRef<string | null>(null)
  const pendingVoiceCommandsRef = useRef<string[]>([])
  const textChunkerRef = useRef(new StreamingTextChunker())
  const queueVoiceDeltaRef = useRef<(messageId: string, nextText: string) => void>(() => {})
  const flushVoiceTurnRef = useRef<() => void>(() => {})
  const stopVoiceOutputRef = useRef<
    (options: { closeSocket: boolean; suppressCurrentTurn: boolean }) => void
  >(() => {})
  const { toast } = useToast()
  const { messages, sendMessage, status, error } = useChat({
    messages: INITIAL_MESSAGES,
  })

  const isLoading = status === 'submitted' || status === 'streaming'

  const setVoiceStatus = (nextStatus: VoiceRuntimeStatus) => {
    voiceRuntimeStatusRef.current = nextStatus
    if (isMountedRef.current) {
      setVoiceRuntimeStatus(nextStatus)
    }
  }

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const abortVoiceTokenRequest = () => {
    if (!voiceTokenAbortControllerRef.current) {
      return
    }

    voiceTokenAbortControllerRef.current.abort()
    voiceTokenAbortControllerRef.current = null
  }

  const resetVoiceTurnState = () => {
    activeAssistantMessageIdRef.current = null
    activeAssistantTextLengthRef.current = 0
    activeVoiceTurnFinalizedRef.current = false
    pendingVoiceCommandsRef.current = []
    textChunkerRef.current.reset()
  }

  const handleVoicePlaybackStateChange = (playerState: 'idle' | 'playing') => {
    if (!voiceModeEnabledRef.current) {
      return
    }

    if (playerState === 'playing') {
      setVoiceStatus('speaking')
      return
    }

    if (activeAssistantMessageIdRef.current && !activeVoiceTurnFinalizedRef.current) {
      setVoiceStatus('connecting')
      return
    }

    setVoiceStatus('stopped')
  }

  const closeVoiceSocket = (sendCloseMessage: boolean) => {
    abortVoiceTokenRequest()

    const socket = voiceSocketRef.current
    if (!socket) {
      voiceSocketConnectedAtRef.current = null
      voiceSocketOpenPromiseRef.current = null
      return
    }

    voiceSocketClosedIntentionallyRef.current = true

    if (socket.readyState === WebSocket.OPEN) {
      if (sendCloseMessage) {
        try {
          socket.send(JSON.stringify({ type: 'Close' } satisfies DeepgramVoiceMessage))
        } catch {}
      }

      socket.close(1000, 'Voice mode ended')
    } else if (socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000, 'Voice mode ended')
    }

    voiceSocketRef.current = null
    voiceSocketConnectedAtRef.current = null
    voiceSocketOpenPromiseRef.current = null
  }

  const stopVoiceOutput = ({
    closeSocket,
    suppressCurrentTurn,
  }: {
    closeSocket: boolean
    suppressCurrentTurn: boolean
  }) => {
    abortVoiceTokenRequest()
    suppressedAssistantMessageIdRef.current = suppressCurrentTurn
      ? activeAssistantMessageIdRef.current
      : null
    pendingVoiceCommandsRef.current = []
    textChunkerRef.current.reset()
    activeAssistantMessageIdRef.current = null
    activeAssistantTextLengthRef.current = 0
    activeVoiceTurnFinalizedRef.current = false

    const socket = voiceSocketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'Clear' } satisfies DeepgramVoiceMessage))
      } catch {}
    }

    voicePlayerRef.current?.stop()

    if (closeSocket) {
      closeVoiceSocket(true)
    } else if (socket?.readyState === WebSocket.CONNECTING) {
      closeVoiceSocket(false)
    }

    setVoiceStatus('stopped')
  }

  const isVoiceSocketStale = () => {
    if (!voiceSocketConnectedAtRef.current) {
      return false
    }

    return Date.now() - voiceSocketConnectedAtRef.current > VOICE_SOCKET_MAX_AGE_MS
  }

  const flushPendingVoiceCommands = () => {
    const socket = voiceSocketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return
    }

    for (const command of pendingVoiceCommandsRef.current) {
      socket.send(command)
    }

    pendingVoiceCommandsRef.current = []
  }

  const handleUnexpectedVoiceSocketClose = () => {
    const shouldToast =
      voiceRuntimeStatusRef.current === 'connecting' || voiceRuntimeStatusRef.current === 'speaking'

    pendingVoiceCommandsRef.current = []
    suppressedAssistantMessageIdRef.current = activeAssistantMessageIdRef.current
    textChunkerRef.current.reset()
    activeAssistantMessageIdRef.current = null
    activeAssistantTextLengthRef.current = 0
    activeVoiceTurnFinalizedRef.current = false
    voicePlayerRef.current?.stop()

    setVoiceStatus(shouldToast ? 'error' : 'stopped')

    if (shouldToast) {
      toast(VOICE_ERROR_TOAST)
    }
  }

  const handleVoiceSocketMessage = async (event: MessageEvent<ArrayBuffer | Blob | string>) => {
    const messageData = event.data

    if (typeof messageData === 'string') {
      try {
        const parsedMessage = JSON.parse(messageData) as
          | { type?: string; description?: string }
          | undefined

        if (parsedMessage?.type === 'Warning') {
          console.warn('[AMA VOICE] Deepgram warning', {
            description: parsedMessage.description ?? 'Unknown warning',
          })
        }
      } catch {}

      return
    }

    const audioBuffer = messageData instanceof Blob ? await messageData.arrayBuffer() : messageData

    voicePlayerRef.current?.enqueueChunk(audioBuffer)
  }

  const ensureAudioContextReady = async () => {
    const AudioContextConstructor = getBrowserAudioContextConstructor()
    if (!AudioContextConstructor) {
      setVoiceStatus('error')
      toast(VOICE_ERROR_TOAST)
      return false
    }

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextConstructor()
      voicePlayerRef.current = new PcmAudioPlayer(audioContextRef.current, {
        sampleRate: DEEPGRAM_STREAM_SAMPLE_RATE,
        onStateChange: handleVoicePlaybackStateChange,
      })
    }

    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume()
    }

    return true
  }

  const fetchVoiceToken = async (): Promise<VoiceTokenResponse> => {
    abortVoiceTokenRequest()
    const abortController = new AbortController()
    voiceTokenAbortControllerRef.current = abortController

    const response = await fetch('/api/tts/token', {
      method: 'POST',
      signal: abortController.signal,
    })

    if (!response.ok) {
      throw new Error('Voice token unavailable')
    }

    const tokenResponse = (await response.json()) as VoiceTokenResponse
    voiceTokenAbortControllerRef.current = null

    return tokenResponse
  }

  const openVoiceSocket = async (token: VoiceTokenResponse) => {
    const deepgramUrl = new URL('wss://api.deepgram.com/v1/speak')
    deepgramUrl.searchParams.set('model', token.model)
    deepgramUrl.searchParams.set('encoding', token.encoding)
    deepgramUrl.searchParams.set('sample_rate', String(token.sampleRate))

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(deepgramUrl, ['bearer', token.accessToken])
      const hadPendingCommands =
        pendingVoiceCommandsRef.current.length > 0 || Boolean(activeAssistantMessageIdRef.current)
      let didOpen = false

      voiceSocketClosedIntentionallyRef.current = false
      voiceSocketRef.current = socket
      socket.binaryType = 'arraybuffer'

      socket.onopen = () => {
        didOpen = true
        voiceSocketConnectedAtRef.current = Date.now()
        flushPendingVoiceCommands()
        setVoiceStatus(hadPendingCommands ? 'connecting' : 'stopped')
        resolve()
      }

      socket.onmessage = (event) => {
        void handleVoiceSocketMessage(event)
      }

      socket.onerror = () => {
        if (!didOpen) {
          reject(new Error('Voice websocket connection failed'))
        }
      }

      socket.onclose = () => {
        const wasIntentional = voiceSocketClosedIntentionallyRef.current
        if (voiceSocketRef.current === socket) {
          voiceSocketRef.current = null
          voiceSocketConnectedAtRef.current = null
        }

        if (!didOpen) {
          reject(new Error('Voice websocket closed before opening'))
          return
        }

        if (!wasIntentional && voiceModeEnabledRef.current) {
          handleUnexpectedVoiceSocketClose()
        }
      }
    })
  }

  const ensureVoiceSocketReady = async (allowRetry = true): Promise<boolean> => {
    if (!voiceModeEnabledRef.current) {
      return false
    }

    if (voiceSocketRef.current?.readyState === WebSocket.OPEN && !isVoiceSocketStale()) {
      return true
    }

    if (voiceSocketOpenPromiseRef.current) {
      return voiceSocketOpenPromiseRef.current
    }

    if (isVoiceSocketStale()) {
      closeVoiceSocket(true)
    } else if (voiceSocketRef.current?.readyState === WebSocket.CLOSED) {
      closeVoiceSocket(false)
    }

    const connectVoiceSocket = async () => {
      setVoiceStatus('connecting')

      const audioReady = await ensureAudioContextReady()
      if (!audioReady) {
        return false
      }

      const token = await fetchVoiceToken()
      if (!voiceModeEnabledRef.current) {
        return false
      }

      await openVoiceSocket(token)
      return true
    }

    let connectionPromise: Promise<boolean> | null = null

    connectionPromise = (async () => {
      try {
        return await connectVoiceSocket()
      } catch (error) {
        if (voiceSocketOpenPromiseRef.current !== connectionPromise) {
          return false
        }

        if (
          allowRetry &&
          !(error instanceof DOMException && error.name === 'AbortError') &&
          voiceModeEnabledRef.current
        ) {
          closeVoiceSocket(false)
          try {
            return await connectVoiceSocket()
          } catch (retryError) {
            error = retryError
          }
        }

        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setVoiceStatus('error')
          toast(VOICE_ERROR_TOAST)
        }

        return false
      } finally {
        if (voiceSocketOpenPromiseRef.current === connectionPromise) {
          voiceSocketOpenPromiseRef.current = null
        }
      }
    })()

    voiceSocketOpenPromiseRef.current = connectionPromise
    return connectionPromise
  }

  const queueVoiceCommand = (command: DeepgramVoiceMessage) => {
    if (!voiceModeEnabledRef.current) {
      return
    }

    const serializedCommand = JSON.stringify(command)

    if (voiceSocketRef.current?.readyState === WebSocket.OPEN && !isVoiceSocketStale()) {
      voiceSocketRef.current.send(serializedCommand)
      return
    }

    pendingVoiceCommandsRef.current.push(serializedCommand)
    void ensureVoiceSocketReady()
  }

  const queueVoiceDelta = (messageId: string, nextText: string) => {
    if (activeAssistantMessageIdRef.current !== messageId) {
      resetVoiceTurnState()
      suppressedAssistantMessageIdRef.current = null
      activeAssistantMessageIdRef.current = messageId
    }

    if (nextText.length < activeAssistantTextLengthRef.current) {
      activeAssistantTextLengthRef.current = 0
      textChunkerRef.current.reset()
    }

    const textDelta = nextText.slice(activeAssistantTextLengthRef.current)
    activeAssistantTextLengthRef.current = nextText.length

    const textChunks = textChunkerRef.current.append(textDelta)
    for (const chunk of textChunks) {
      queueVoiceCommand({ type: 'Speak', text: chunk })
    }

    if (textChunks.length > 0 && voiceRuntimeStatusRef.current !== 'speaking') {
      setVoiceStatus('connecting')
    }
  }

  const flushVoiceTurn = () => {
    const finalChunks = textChunkerRef.current.flush()
    for (const chunk of finalChunks) {
      queueVoiceCommand({ type: 'Speak', text: chunk })
    }

    if (activeAssistantTextLengthRef.current > 0) {
      queueVoiceCommand({ type: 'Flush' })
      activeVoiceTurnFinalizedRef.current = true

      if (voiceRuntimeStatusRef.current !== 'speaking') {
        setVoiceStatus('connecting')
      }
    }
  }

  const handleVoiceModeChange = (checked: boolean) => {
    setVoiceModeEnabled(checked)
    voiceModeEnabledRef.current = checked

    try {
      localStorage.setItem(AMA_VOICE_MODE_STORAGE_KEY, checked ? 'true' : 'false')
    } catch {}

    if (checked) {
      void ensureVoiceSocketReady()
      return
    }

    stopVoiceOutput({ closeSocket: true, suppressCurrentTurn: false })
  }

  queueVoiceDeltaRef.current = queueVoiceDelta
  flushVoiceTurnRef.current = flushVoiceTurn
  stopVoiceOutputRef.current = stopVoiceOutput

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  useEffect(() => {
    try {
      const storedValue = localStorage.getItem(AMA_VOICE_MODE_STORAGE_KEY)
      if (storedValue === 'true') {
        setVoiceModeEnabled(true)
        voiceModeEnabledRef.current = true
      }
    } catch {}
  }, [])

  useEffect(() => {
    if (!error) {
      return
    }

    toast(API_ERROR_TOAST)
  }, [error, toast])

  useEffect(() => {
    if (!voiceModeEnabled) {
      return
    }

    const lastMessage = messages[messages.length - 1]
    if (!lastMessage || lastMessage.id === INITIAL_MESSAGE_ID || lastMessage.role !== 'assistant') {
      return
    }

    if (suppressedAssistantMessageIdRef.current === lastMessage.id) {
      return
    }

    const lastMessageText = getMessageText(lastMessage.parts)
    if (!lastMessageText.trim()) {
      return
    }

    if (isLoading) {
      queueVoiceDeltaRef.current(lastMessage.id, lastMessageText)
      return
    }

    if (
      activeAssistantMessageIdRef.current === lastMessage.id &&
      !activeVoiceTurnFinalizedRef.current
    ) {
      queueVoiceDeltaRef.current(lastMessage.id, lastMessageText)
      flushVoiceTurnRef.current()
    }
  }, [isLoading, messages, voiceModeEnabled])

  useEffect(() => {
    return () => {
      isMountedRef.current = false
      stopVoiceOutputRef.current({ closeSocket: true, suppressCurrentTurn: false })

      if (audioContextRef.current) {
        void audioContextRef.current.close()
      }
    }
  }, [])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    if (!input.trim() || isLoading) {
      return
    }

    const text = input
    setInput('')

    if (voiceModeEnabledRef.current) {
      stopVoiceOutput({ closeSocket: false, suppressCurrentTurn: false })
      void ensureVoiceSocketReady()
    }

    try {
      await sendMessage({ text })
    } catch {
      toast(API_ERROR_TOAST)
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <div className="flex-1 container mx-auto px-4 py-8 flex flex-col">
        <div className="terminal-window flex-1 flex flex-col">
          <div
            id={AMA_TRANSCRIPT_ID}
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            aria-busy={isLoading}
            className="terminal-window-content flex-1 overflow-y-auto font-mono"
          >
            {messages.map((message) => {
              const text = getMessageText(message.parts)

              if (message.role === 'assistant' && !text.trim()) {
                return null
              }

              return (
                <div key={message.id} className="mb-4">
                  {message.role === 'user' ? (
                    <div className="text-foreground">
                      <span className="text-muted-foreground">segov@terminal:~$ </span>
                      <span>{text}</span>
                    </div>
                  ) : (
                    <div className="text-foreground whitespace-pre-line">{text}</div>
                  )}
                </div>
              )
            })}
            <div ref={messagesEndRef} />
          </div>

          <form onSubmit={handleSubmit} className="border-t border-border/30 p-4">
            <div className="flex items-center">
              <label htmlFor={AMA_INPUT_ID} className="sr-only">
                Ask a question
              </label>
              <span className="text-foreground mr-2">$</span>
              <input
                id={AMA_INPUT_ID}
                type="text"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                className="terminal-input flex-1 font-mono"
                disabled={isLoading}
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3 font-mono text-sm">
              <div className="flex items-center gap-2">
                <label htmlFor={AMA_VOICE_MODE_ID} className="text-foreground">
                  Voice Mode
                </label>
                <Switch
                  id={AMA_VOICE_MODE_ID}
                  checked={voiceModeEnabled}
                  onCheckedChange={handleVoiceModeChange}
                  aria-label="Toggle voice mode"
                />
              </div>

              {voiceModeEnabled ? (
                <>
                  <span role="status" aria-live="polite" className="text-muted-foreground">
                    {VOICE_RUNTIME_LABELS[voiceRuntimeStatus]}
                  </span>

                  {(voiceRuntimeStatus === 'connecting' || voiceRuntimeStatus === 'speaking') && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="font-mono"
                      onClick={() =>
                        stopVoiceOutput({ closeSocket: false, suppressCurrentTurn: true })
                      }
                    >
                      Stop Voice
                    </Button>
                  )}
                </>
              ) : null}
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
