'use client'

import React, { useState, useRef, useEffect } from 'react'
import { Navbar } from '@/components/navbar'
import { useToast } from '@/hooks/use-toast'
import { type UIMessage, useChat } from '@ai-sdk/react'
import { RotateCcw, Square, Trash2 } from 'lucide-react'
import { Streamdown } from 'streamdown'
import { getAmaStreamErrorType, summarizeAmaUiMessage } from '@/lib/ama-stream-diagnostics'

const LEGACY_INITIAL_ASSISTANT_MESSAGE = 'segov@terminal:~$ ./ama \nAsk me anything about Jonathan.'
const INITIAL_ASSISTANT_MESSAGE =
  'segov@terminal:~$ ./ama \nAsk me anything about my work and projects.'
const INITIAL_MESSAGES: UIMessage[] = [
  {
    id: 'initial',
    role: 'assistant',
    parts: [{ type: 'text', text: INITIAL_ASSISTANT_MESSAGE }],
  },
]

const AMA_STORAGE_KEY = 'segov-dev:ama:v1'
const HELP_MESSAGE = [
  'Commands:',
  'help - show this help',
  'clear/reset - clear this local session',
  'stop - stop the current response',
  'retry/again - regenerate the last response',
].join('\n')
const PROMPT_SUGGESTIONS = [
  'Tell me about your career',
  'What projects best show your AI work?',
  'What kind of engineer are you?',
  'How did you build this website?',
  'What have you built outside work?',
]
const DEFAULT_FOLLOW_UPS = [
  'Tell me about your career',
  'What projects best show your AI work?',
  'What kind of engineer are you?',
]
const CAREER_FOLLOW_UPS = [
  'What backend or platform work have you done?',
  'How do you approach engineering problems?',
  'Which skills show up repeatedly in your work?',
]
const PROJECT_FOLLOW_UPS = [
  'What are your most notable projects?',
  'Which of your projects use AI?',
  'How did you build segov.dev?',
]
const SAFE_MARKDOWN_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

function transformMarkdownUrl(url: string): string | null {
  const trimmedUrl = url.trim()
  if (!trimmedUrl) {
    return null
  }

  const hasProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmedUrl)
  if (!hasProtocol && !trimmedUrl.startsWith('//')) {
    return trimmedUrl
  }

  try {
    const parsedUrl = new URL(trimmedUrl)
    return SAFE_MARKDOWN_PROTOCOLS.has(parsedUrl.protocol.toLowerCase()) ? trimmedUrl : null
  } catch {
    return null
  }
}

function getMessageText(parts: UIMessage['parts']): string {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

function createMessageId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function createTextMessage(role: 'user' | 'assistant', text: string): UIMessage {
  return {
    id: createMessageId(),
    role,
    parts: [{ type: 'text', text }],
  }
}

function sanitizeMessages(messages: UIMessage[]): UIMessage[] {
  const sanitizedMessages = messages.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return []
    }

    const storedText = getMessageText(message.parts)
    const text =
      message.id === 'initial' &&
      message.role === 'assistant' &&
      storedText === LEGACY_INITIAL_ASSISTANT_MESSAGE
        ? INITIAL_ASSISTANT_MESSAGE
        : storedText
    if (!text.trim()) {
      return []
    }

    return [
      {
        id: typeof message.id === 'string' ? message.id : createMessageId(),
        role: message.role,
        parts: [{ type: 'text', text }],
      } satisfies UIMessage,
    ]
  })

  return sanitizedMessages.length > 0 ? sanitizedMessages : INITIAL_MESSAGES
}

function loadStoredMessages(): UIMessage[] | null {
  try {
    const serializedMessages = window.localStorage.getItem(AMA_STORAGE_KEY)
    if (!serializedMessages) {
      return null
    }

    const parsedMessages = JSON.parse(serializedMessages)
    if (!Array.isArray(parsedMessages)) {
      return INITIAL_MESSAGES
    }

    return sanitizeMessages(parsedMessages as UIMessage[])
  } catch {
    return INITIAL_MESSAGES
  }
}

function persistSanitizedMessages(sanitizedMessages: UIMessage[]) {
  window.localStorage.setItem(AMA_STORAGE_KEY, JSON.stringify(sanitizedMessages))
}

function clearStoredMessages() {
  window.localStorage.removeItem(AMA_STORAGE_KEY)
}

function hasUserMessage(messages: UIMessage[]): boolean {
  return messages.some((message) => message.role === 'user' && getMessageText(message.parts).trim())
}

function isInitialMessageSet(sanitizedMessages: UIMessage[]): boolean {
  return (
    sanitizedMessages.length === 1 &&
    sanitizedMessages[0]?.id === 'initial' &&
    getMessageText(sanitizedMessages[0].parts) === INITIAL_ASSISTANT_MESSAGE
  )
}

function isInitialSession(messages: UIMessage[]): boolean {
  return isInitialMessageSet(sanitizeMessages(messages))
}

function getFollowUpSuggestions(messages: UIMessage[]): string[] {
  if (!hasUserMessage(messages)) {
    return []
  }

  const latestAssistant = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === 'assistant' &&
        message.id !== 'initial' &&
        getMessageText(message.parts).trim(),
    )

  if (!latestAssistant) {
    return []
  }

  const latestUser = [...messages]
    .reverse()
    .find((message) => message.role === 'user' && getMessageText(message.parts).trim())
  const combinedText = `${getMessageText(latestUser?.parts ?? [])} ${getMessageText(
    latestAssistant.parts,
  )}`.toLowerCase()

  if (/(?:\b(?:projects?|sites?|websites?|built|build|ai|side)\b|segov\.dev)/.test(combinedText)) {
    return PROJECT_FOLLOW_UPS
  }

  if (
    /\b(?:career|work|jobs?|compan(?:y|ies)|resume|engineers?|engineering|backend|platform)\b/.test(
      combinedText,
    )
  ) {
    return CAREER_FOLLOW_UPS
  }

  return DEFAULT_FOLLOW_UPS
}

export default function AMAPage() {
  const [input, setInput] = useState('')
  const [hasHydratedMessages, setHasHydratedMessages] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const { toast } = useToast()
  const { messages, sendMessage, status, error, stop, regenerate, setMessages, clearError } =
    useChat({
      messages: INITIAL_MESSAGES,
      onFinish: ({ message, finishReason, isAbort, isDisconnect, isError }) => {
        console.info(
          JSON.stringify({
            event: 'ama_client_ui_stream_finish',
            finishReason,
            isAbort,
            isDisconnect,
            isError,
            message: summarizeAmaUiMessage(message),
          }),
        )
      },
      onError: (chatError) => {
        console.error(
          JSON.stringify({
            event: 'ama_client_ui_stream_error',
            errorType: getAmaStreamErrorType(chatError),
          }),
        )
      },
    })

  const isLoading = status === 'submitted' || status === 'streaming'
  const canRetry = !isLoading && hasUserMessage(messages)
  const canStop = isLoading
  const canClear = !isLoading && !isInitialSession(messages)
  const followUpSuggestions = isLoading ? [] : getFollowUpSuggestions(messages)
  const promptSuggestions = hasUserMessage(messages) || isLoading ? [] : PROMPT_SUGGESTIONS

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    const storedMessages = loadStoredMessages()
    if (storedMessages) {
      setMessages(storedMessages)
    }
    setHasHydratedMessages(true)
  }, [setMessages])

  // Fire-and-forget: pre-warm a scale-to-zero inference backend so its cold
  // start overlaps with the visitor typing their first message. Server route
  // no-ops when the gateway path is active.
  useEffect(() => {
    void fetch('/api/chat/wake', { method: 'POST' }).catch(() => undefined)
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  useEffect(() => {
    if (!hasHydratedMessages || isLoading) {
      return
    }

    const sanitizedMessages = sanitizeMessages(messages)
    if (isInitialMessageSet(sanitizedMessages)) {
      clearStoredMessages()
    } else {
      persistSanitizedMessages(sanitizedMessages)
    }
  }, [hasHydratedMessages, isLoading, messages])

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

  function appendLocalAssistantMessage(text: string, commandText?: string) {
    const baseMessages = messages
    const nextMessages = commandText
      ? [
          ...baseMessages,
          createTextMessage('user', commandText),
          createTextMessage('assistant', text),
        ]
      : [...baseMessages, createTextMessage('assistant', text)]

    setMessages(nextMessages)
  }

  function resetSession() {
    clearError()
    clearStoredMessages()
    setMessages(INITIAL_MESSAGES)
  }

  async function retryLastResponse() {
    clearError()
    await regenerate()
  }

  async function submitText(text: string): Promise<boolean> {
    const trimmedText = text.trim()
    if (!trimmedText) {
      return false
    }

    const command = trimmedText.toLowerCase()
    clearError()

    if (command === 'stop') {
      if (isLoading) {
        stop()
      } else {
        appendLocalAssistantMessage('No active response.', trimmedText)
      }
      return true
    }

    if (isLoading) {
      return false
    }

    if (command === 'help') {
      appendLocalAssistantMessage(HELP_MESSAGE, trimmedText)
      return true
    }

    if (command === 'clear' || command === 'reset') {
      resetSession()
      return true
    }

    if (command === 'retry' || command === 'again') {
      if (canRetry) {
        await retryLastResponse()
      } else {
        appendLocalAssistantMessage('No previous prompt to retry.', trimmedText)
      }
      return true
    }

    try {
      await sendMessage({ text: trimmedText })
    } catch {
      toast({
        title: 'API Error',
        description: 'Failed to get a response from the API. Please try again later.',
        variant: 'destructive',
      })
    }
    return true
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const didConsumeInput = await submitText(input)
    if (didConsumeInput) {
      setInput('')
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <div className="flex-1 container mx-auto px-4 py-8 flex flex-col">
        <div className="terminal-window flex-1 flex flex-col">
          <div className="terminal-window-content flex-1 overflow-y-auto font-mono">
            {messages.map((message, messageIndex) => {
              const text = getMessageText(message.parts)
              const isStreamingAssistantMessage =
                status === 'streaming' &&
                message.role === 'assistant' &&
                messageIndex === messages.length - 1

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
                    <Streamdown
                      className="ama-markdown whitespace-pre-line text-foreground"
                      disallowedElements={['img']}
                      isAnimating={isStreamingAssistantMessage}
                      mode={isStreamingAssistantMessage ? 'streaming' : 'static'}
                      skipHtml
                      urlTransform={transformMarkdownUrl}
                    >
                      {text}
                    </Streamdown>
                  )}
                </div>
              )
            })}
            {promptSuggestions.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {promptSuggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => void submitText(suggestion)}
                    className="rounded border border-border/30 px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
            {followUpSuggestions.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {followUpSuggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => void submitText(suggestion)}
                    className="rounded border border-border/30 px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <form onSubmit={handleSubmit} className="border-t border-border/30 p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              <div className="flex min-w-0 flex-1 items-center">
                <span className="text-foreground mr-2">$</span>
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  className="terminal-input flex-1 font-mono"
                  disabled={isLoading}
                />
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={stop}
                  disabled={!canStop}
                  className="inline-flex items-center gap-1 rounded border border-border/30 px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Square size={12} />
                  Stop
                </button>
                <button
                  type="button"
                  onClick={() => void retryLastResponse()}
                  disabled={!canRetry}
                  className="inline-flex items-center gap-1 rounded border border-border/30 px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RotateCcw size={12} />
                  Retry
                </button>
                <button
                  type="button"
                  onClick={resetSession}
                  disabled={!canClear}
                  className="inline-flex items-center gap-1 rounded border border-border/30 px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Trash2 size={12} />
                  Clear
                </button>
              </div>
            </div>
          </form>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Conversations are stored server-side and may be reviewed or used to improve this chatbot.
          Do not submit sensitive personal information.
        </p>
      </div>
    </div>
  )
}
