import { createAgentUIStreamResponse } from 'ai'
import { createAmaAgent } from '@/lib/ama-agent'
import { readAmaSessionSnapshotFromCookieHeader } from '@/lib/ama-session'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response('Invalid request payload.', { status: 400 })
  }

  const messages = (body as { messages?: unknown })?.messages
  if (!Array.isArray(messages)) {
    return new Response('Invalid request payload: expected messages array.', { status: 400 })
  }

  const sessionSnapshot = readAmaSessionSnapshotFromCookieHeader(req.headers.get('cookie'))
  if (!sessionSnapshot) {
    return new Response('AMA session unavailable.', { status: 503 })
  }

  try {
    return await streamAmaChat(messages, {
      modelId: sessionSnapshot.primary.modelId,
      providerOrder: sessionSnapshot.primary.providerOrder,
    })
  } catch {
    if (sessionSnapshot.fallback) {
      try {
        return await streamAmaChat(messages, {
          modelId: sessionSnapshot.fallback.modelId,
          providerOrder: sessionSnapshot.fallback.providerOrder,
        })
      } catch {
        return new Response('Chat service unavailable.', { status: 500 })
      }
    }

    return new Response('Chat service unavailable.', { status: 500 })
  }
}

async function streamAmaChat(
  messages: unknown[],
  { modelId, providerOrder }: { modelId: string; providerOrder?: string[] },
) {
  return createAgentUIStreamResponse({
    agent: createAmaAgent({
      modelId,
      providerOrder,
    }),
    messages,
  })
}
