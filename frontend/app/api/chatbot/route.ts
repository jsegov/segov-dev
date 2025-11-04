import { NextResponse } from "next/server"

const CHAT_BACKEND_URL = process.env.CHAT_BACKEND_URL || 'http://localhost:8080'

export async function POST(req: Request) {
  console.log("[CHATBOT API] Received request")

  try {
    const body = await req.json()
    console.log("[CHATBOT API] Request body:", body)

    const { question } = body

    if (!question || typeof question !== "string") {
      console.log("[CHATBOT API] Invalid question format:", question)
      return NextResponse.json({ error: "Invalid question format" }, { status: 400 })
    }

    // Call backend chat API
    const backendUrl = `${CHAT_BACKEND_URL}/v1/chat`
    console.log("[CHATBOT API] Calling backend:", backendUrl)

    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session_id: 'anon',
        input: question,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error("[CHATBOT API] Backend error:", response.status, errorText)
      
      if (response.status === 401) {
        return new Response(
          `segov@terminal:~$ echo "Error: Invalid API key"
Error: Invalid API key. Please check your OpenAI API key configuration.`,
          { status: 401 },
        )
      }

      return new Response(
        `segov@terminal:~$ echo "Error: API service unavailable"
Error: ${errorText || 'Backend service unavailable'}. Please try again later.`,
        { status: response.status || 500 },
      )
    }

    const data = await response.json()
    const text = data.text || ''

    if (!text || text.trim().length === 0) {
      console.error("[CHATBOT API] Empty response from backend")
      return new Response(
        "segov@terminal:~$ echo 'Error: Empty response from server'\nError: Empty response from server",
        { status: 500 },
      )
    }

    console.log("[CHATBOT API] Response received, length:", text.length)

    return new Response(text, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    })
  } catch (error) {
    console.error("[CHATBOT API] General error:", error)

    return new Response(
      `segov@terminal:~$ echo "Error: Something went wrong"
Error: Something went wrong. Please try again later.`,
      { status: 500 },
    )
  }
}

