'use client'

import React, { useState, useRef, useEffect } from 'react'
import { Navbar } from '@/components/navbar'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { type UIMessage, useChat } from '@ai-sdk/react'

const INITIAL_ASSISTANT_MESSAGE = 'segov@terminal:~$ ./ama \nAsk me anything about Jonathan.'
const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,UklGRmQGAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const INITIAL_MESSAGE_ID = 'initial'
const AMA_INPUT_ID = 'ama-input'
const AMA_TRANSCRIPT_ID = 'ama-transcript'
const TTS_ERROR_TOAST = {
  title: 'Audio Error',
  description: 'Failed to play audio for this response. Please try again later.',
  variant: 'destructive' as const,
}
const INITIAL_MESSAGES: UIMessage[] = [
  {
    id: INITIAL_MESSAGE_ID,
    role: 'assistant',
    parts: [{ type: 'text', text: INITIAL_ASSISTANT_MESSAGE }],
  },
]

function getMessageText(parts: UIMessage['parts']): string {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

function getAssistantTtsState(
  message: UIMessage,
  index: number,
  totalMessages: number,
  isChatLoading: boolean,
) {
  const text = getMessageText(message.parts)
  const isInitialMessage = message.id === INITIAL_MESSAGE_ID
  const isStreamingAssistantReply =
    isChatLoading && message.role === 'assistant' && index === totalMessages - 1
  const showTtsControl =
    message.role === 'assistant' &&
    !isInitialMessage &&
    !isStreamingAssistantReply &&
    Boolean(text.trim())

  return {
    text,
    showTtsControl,
  }
}

async function primeAudioPlayback(audio: HTMLAudioElement) {
  audio.src = SILENT_WAV_DATA_URI
  audio.muted = true

  try {
    await audio.play()
  } catch {
    audio.removeAttribute('src')
    audio.load()
    audio.muted = false
    return
  }

  audio.pause()
  audio.currentTime = 0
  audio.removeAttribute('src')
  audio.load()
  audio.muted = false
}

export default function AMAPage() {
  const [input, setInput] = useState('')
  const [loadingMessageId, setLoadingMessageId] = useState<string | null>(null)
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const ttsRequestInFlightRef = useRef(false)
  const { toast } = useToast()
  const { messages, sendMessage, status, error } = useChat({
    messages: INITIAL_MESSAGES,
  })

  const isLoading = status === 'submitted' || status === 'streaming'
  let assistantResponseNumber = 0
  const messageDisplayState = messages.map((message, index) => {
    const ttsState = getAssistantTtsState(message, index, messages.length, isLoading)
    const assistantResponseLabelNumber = ttsState.showTtsControl ? ++assistantResponseNumber : null

    return {
      message,
      text: ttsState.text,
      showTtsControl: ttsState.showTtsControl,
      assistantResponseLabelNumber,
    }
  })

  const releaseAudioUrl = () => {
    if (!audioUrlRef.current) {
      return
    }

    URL.revokeObjectURL(audioUrlRef.current)
    audioUrlRef.current = null
  }

  const clearActiveAudio = () => {
    if (audioRef.current) {
      audioRef.current.onended = null
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      audioRef.current = null
    }

    releaseAudioUrl()
  }

  const stopAudioPlayback = () => {
    clearActiveAudio()
    ttsRequestInFlightRef.current = false
    setLoadingMessageId(null)
    setPlayingMessageId(null)
  }

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.onended = null
        audioRef.current.pause()
        audioRef.current.currentTime = 0
        audioRef.current = null
      }

      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current)
        audioUrlRef.current = null
      }

      ttsRequestInFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!error) {
      return
    }
    toast({
      title: 'API Error',
      description: 'Failed to get a response from the API. Please try again later.',
      variant: 'destructive',
    })
  }, [error, toast])

  async function handlePlayMessage(messageId: string, text: string) {
    if (ttsRequestInFlightRef.current) {
      return
    }

    stopAudioPlayback()
    ttsRequestInFlightRef.current = true
    setLoadingMessageId(messageId)

    try {
      const audio = new Audio()
      await primeAudioPlayback(audio)

      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      })

      if (!response.ok) {
        throw new Error('Text to speech unavailable')
      }

      const audioBlob = await response.blob()
      const audioUrl = URL.createObjectURL(audioBlob)
      audio.src = audioUrl

      audio.onended = () => {
        if (audioRef.current !== audio) {
          return
        }

        clearActiveAudio()
        setLoadingMessageId(null)
        setPlayingMessageId(null)
      }

      audioRef.current = audio
      audioUrlRef.current = audioUrl

      await audio.play()

      if (audioRef.current !== audio) {
        return
      }

      ttsRequestInFlightRef.current = false
      setLoadingMessageId(null)
      setPlayingMessageId(messageId)
    } catch (error) {
      stopAudioPlayback()

      if (error instanceof DOMException && error.name === 'AbortError') {
        return
      }

      toast(TTS_ERROR_TOAST)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!input.trim() || isLoading) {
      return
    }

    const text = input
    setInput('')

    try {
      await sendMessage({ text })
    } catch {
      toast({
        title: 'API Error',
        description: 'Failed to get a response from the API. Please try again later.',
        variant: 'destructive',
      })
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
            {messageDisplayState.map(
              ({ message, text, showTtsControl, assistantResponseLabelNumber }) => {
                const isTtsLoading = loadingMessageId === message.id
                const isTtsPlaying = playingMessageId === message.id

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
                      <div>
                        <div className="text-foreground whitespace-pre-line">{text}</div>
                        {showTtsControl ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-2 font-mono"
                            aria-label={
                              isTtsLoading
                                ? `Loading audio for assistant response ${assistantResponseLabelNumber}`
                                : isTtsPlaying
                                  ? `Stop audio for assistant response ${assistantResponseLabelNumber}`
                                  : `Play audio for assistant response ${assistantResponseLabelNumber}`
                            }
                            aria-pressed={isTtsPlaying}
                            disabled={Boolean(loadingMessageId)}
                            onClick={() =>
                              isTtsPlaying
                                ? stopAudioPlayback()
                                : handlePlayMessage(message.id, text)
                            }
                          >
                            {isTtsLoading ? 'Loading...' : isTtsPlaying ? 'Stop' : 'Play'}
                          </Button>
                        ) : null}
                      </div>
                    )}
                  </div>
                )
              },
            )}
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
                onChange={(e) => setInput(e.target.value)}
                className="terminal-input flex-1 font-mono"
                disabled={isLoading}
              />
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
