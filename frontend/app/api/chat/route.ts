import { createAgentUIStreamResponse } from 'ai'
import { createAmaAgent } from '@/lib/ama-agent'

export const runtime = 'nodejs'

const agent = createAmaAgent()

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

  try {
    return await createAgentUIStreamResponse({
      agent,
      messages,
    })
  } catch {
    return new Response('Chat service unavailable.', { status: 500 })
  }
}
