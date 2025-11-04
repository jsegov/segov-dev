import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { randomUUID } from "crypto"
import { getCloudRunIdToken, fetchCloudRun } from "@/lib/gcp-wif"

const CHAT_BACKEND_URL = process.env.CHAT_BACKEND_URL || 'http://localhost:8080'
const CLOUD_RUN_URL = process.env.CLOUD_RUN_URL
const SESSION_COOKIE_NAME = 'chat_session_id'

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

    // Get or create session ID from cookies
    const cookieStore = await cookies()
    let sessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value
    
    if (!sessionId) {
      sessionId = randomUUID()
      cookieStore.set(SESSION_COOKIE_NAME, sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30, // 30 days
      })
      console.log("[CHATBOT API] Generated new session ID:", sessionId)
    } else {
      console.log("[CHATBOT API] Using existing session ID:", sessionId)
    }

    // Call backend chat API
    // Use Cloud Run with auth if CLOUD_RUN_URL is set (production), otherwise use local dev
    let response: Response
    
    if (CLOUD_RUN_URL) {
      // Production: Get ID token and call Cloud Run with authentication
      console.log("[CHATBOT API] Using Cloud Run with WIF authentication:", CLOUD_RUN_URL)
      
      try {
        const idToken = await getCloudRunIdToken({
          projectNumber: process.env.GCP_PROJECT_NUMBER!,
          poolId: process.env.WIF_POOL_ID!,
          providerId: process.env.WIF_PROVIDER_ID!,
          serviceAccountEmail: process.env.SERVICE_ACCOUNT_EMAIL!,
          audience: CLOUD_RUN_URL,
        })
        
        const backendUrl = `${CLOUD_RUN_URL}/v1/chat`
        response = await fetchCloudRun(backendUrl, {
          method: 'POST',
          idToken,
          body: JSON.stringify({
            session_id: sessionId,
            input: question,
          }),
        })
      } catch (authError) {
        console.error("[CHATBOT API] Authentication error:", authError)
        return new Response(
          `segov@terminal:~$ echo "Error: Authentication failed"
Error: Failed to authenticate with backend service. Please check configuration.`,
          { status: 500 },
        )
      }
    } else {
      // Local development: call local backend without auth
      const backendUrl = `${CHAT_BACKEND_URL}/v1/chat`
      console.log("[CHATBOT API] Using local backend (no auth):", backendUrl)
      
      response = await fetch(backendUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session_id: sessionId,
          input: question,
        }),
      })
    }

    if (!response.ok) {
      const errorText = await response.text()
      console.error("[CHATBOT API] Backend error:", response.status, errorText)
      
      if (response.status === 401 || response.status === 403) {
        console.error("[CHATBOT API] Authentication/Authorization error:", response.status)
        return new Response(
          `segov@terminal:~$ echo "Error: Authentication failed"
Error: Backend authentication failed. Please check your configuration.`,
          { status: response.status },
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

