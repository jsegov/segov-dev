"use client"

import type React from "react"

import { useState, useRef, useEffect } from "react"
import { Navbar } from "@/components/navbar"
import { useToast } from "@/components/ui/use-toast"

interface Message {
  role: "user" | "assistant"
  content: string
  id: string
}

export default function AMAPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const { toast } = useToast()

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  // Add initial message when component mounts
  useEffect(() => {
    setMessages([
      {
        role: "assistant",
        content:
          "segov@terminal:~$ ./ama \nAsk me anything about Jonathan.",
        id: "initial",
      },
    ])
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!input.trim() || isLoading) return

    const userMessage: Message = {
      role: "user",
      content: input,
      id: Date.now().toString(),
    }

    setMessages((prev) => [...prev, userMessage])
    setInput("")
    setIsLoading(true)

    // Create a placeholder for the assistant's message
    const assistantMessageId = (Date.now() + 1).toString()
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "segov@terminal:~$ processing...", id: assistantMessageId },
    ])

    try {
      console.log("Sending request to API with question:", input)

      // Make direct API call for every question
      const response = await fetch("/api/chatbot", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ question: input }),
      })

      console.log("Received API response:", {
        status: response.status,
        statusText: response.statusText,
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error("API error response:", errorText)
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      // Get the response text
      console.log("Reading response body...")
      const responseText = await response.text()
      console.log("Response received, length:", responseText.length)
      console.log("Response preview:", responseText.substring(0, 200))

      if (!responseText || responseText.trim().length === 0) {
        console.error("Empty response received from API")
        setMessages((prev) =>
          prev.map((msg) => (msg.id === assistantMessageId ? { ...msg, content: "segov@terminal:~$ echo 'Error: Empty response from server'\nError: Empty response from server" } : msg)),
        )
        return
      }

      // Update the message with the API response
      setMessages((prev) =>
        prev.map((msg) => (msg.id === assistantMessageId ? { ...msg, content: responseText } : msg)),
      )
    } catch (error) {
      console.error("Error in API call:", error)

      // Update the placeholder message with the error
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId
            ? {
              ...msg,
              content:
                "Error: API call failed. Please try again later.",
            }
            : msg,
        ),
      )

      toast({
        title: "API Error",
        description: "Failed to get a response from the API. Please try again later.",
        variant: "destructive",
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <div className="flex-1 container mx-auto px-4 py-8 flex flex-col">
        <div className="terminal-window flex-1 flex flex-col">
          <div className="terminal-window-content flex-1 overflow-y-auto font-mono">
            {messages.map((message) => (
              <div key={message.id} className="mb-4">
                {message.role === "user" ? (
                  <div className="text-foreground">
                    <span className="text-muted-foreground">segov@terminal:~$ </span>
                    <span>{message.content}</span>
                  </div>
                ) : (
                  <div className="text-foreground whitespace-pre-line">{message.content}</div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <form onSubmit={handleSubmit} className="border-t border-border/30 p-4">
            <div className="flex items-center">
              <span className="text-foreground mr-2">$</span>
              <input
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
