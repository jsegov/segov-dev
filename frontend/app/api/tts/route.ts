import { z } from 'zod'

const DEEPGRAM_TTS_URL = 'https://api.deepgram.com/v1/speak'
const DEFAULT_DEEPGRAM_TTS_MODEL = 'aura-2-thalia-en'
const MAX_TTS_TEXT_LENGTH = 2000
const TtsRequestSchema = z.object({
  text: z.string(),
})

export const runtime = 'nodejs'

function normalizeTtsText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response('Invalid request payload.', { status: 400 })
  }

  const parsedBody = TtsRequestSchema.safeParse(body)
  if (!parsedBody.success) {
    return new Response('Invalid request payload: expected text string.', { status: 400 })
  }

  const text = normalizeTtsText(parsedBody.data.text)
  if (!text) {
    return new Response('Invalid request payload: expected non-empty text.', { status: 400 })
  }

  if (text.length > MAX_TTS_TEXT_LENGTH) {
    return new Response('Text exceeds the maximum supported length.', { status: 422 })
  }

  const apiKey = process.env.DEEPGRAM_API_KEY?.trim()
  if (!apiKey) {
    return new Response('Text to speech unavailable.', { status: 503 })
  }

  const model = process.env.DEEPGRAM_TTS_MODEL?.trim() || DEFAULT_DEEPGRAM_TTS_MODEL
  const deepgramUrl = new URL(DEEPGRAM_TTS_URL)
  deepgramUrl.searchParams.set('model', model)
  deepgramUrl.searchParams.set('encoding', 'mp3')

  try {
    const deepgramResponse = await fetch(deepgramUrl, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
      cache: 'no-store',
    })

    const requestId = deepgramResponse.headers.get('dg-request-id')

    if (!deepgramResponse.ok || !deepgramResponse.body) {
      console.error('[TTS API] Deepgram request failed', {
        status: deepgramResponse.status,
        requestId,
      })
      return new Response('Text to speech unavailable.', { status: 502 })
    }

    return new Response(deepgramResponse.body, {
      status: 200,
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Type': 'audio/mpeg',
      },
    })
  } catch {
    console.error('[TTS API] Deepgram request failed', {
      status: 'network_error',
      requestId: null,
    })
    return new Response('Text to speech unavailable.', { status: 502 })
  }
}
