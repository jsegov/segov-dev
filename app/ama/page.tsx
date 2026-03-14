'use client'

import React, { useState, useRef, useEffect } from 'react'
import { Navbar } from '@/components/navbar'
import { useToast } from '@/components/ui/use-toast'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, isTextUIPart, type UIMessage } from 'ai'

const INITIAL_ASSISTANT_MESSAGE = 'segov@terminal:~$ ./ama \nAsk me anything about Jonathan.'
const CHAT_TRANSPORT = new DefaultChatTransport({
  api: '/api/chat',
})
const INITIAL_MESSAGES = [
  {
    id: 'initial',
    role: 'assistant' as const,
    parts: [{ type: 'text' as const, text: INITIAL_ASSISTANT_MESSAGE }],
  },
]

export default function AMAPage() {
  const [input, setInput] = useState('')
  const [sessionReady, setSessionReady] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const { toast } = useToast()
  const { messages, sendMessage, status, error } = useChat({
    transport: CHAT_TRANSPORT,
    messages: INITIAL_MESSAGES,
  })

  const isLoading = status === 'submitted' || status === 'streaming'
  const isInputDisabled = !sessionReady || isLoading

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

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

  useEffect(() => {
    let cancelled = false

    const bootstrapAmaSession = async () => {
      try {
        const response = await fetch('/api/ama/session', {
          method: 'GET',
          cache: 'no-store',
        })

        if (!response.ok) {
          throw new Error('Failed to initialize AMA session')
        }

        if (!cancelled) {
          setSessionReady(true)
        }
      } catch {
        if (!cancelled) {
          toast({
            title: 'API Error',
            description: 'Failed to initialize the AMA session. Please refresh and try again.',
            variant: 'destructive',
          })
        }
      }
    }

    bootstrapAmaSession()

    return () => {
      cancelled = true
    }
  }, [toast])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!input.trim() || isInputDisabled) {
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

  const getMessageText = (parts: UIMessage['parts']) =>
    parts
      .filter(isTextUIPart)
      .map((part) => part.text)
      .join('')

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <div className="flex-1 container mx-auto px-4 py-8 flex flex-col">
        <div className="terminal-window flex-1 flex flex-col">
          <div className="terminal-window-content flex-1 overflow-y-auto font-mono">
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
            {!sessionReady ? (
              <div className="mb-3 text-sm text-muted-foreground">Preparing AMA session...</div>
            ) : null}
            <div className="flex items-center">
              <span className="text-foreground mr-2">$</span>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                className="terminal-input flex-1 font-mono"
                disabled={isInputDisabled}
              />
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
