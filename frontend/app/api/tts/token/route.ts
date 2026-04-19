import { z } from 'zod'
import { DEEPGRAM_STREAM_ENCODING, DEEPGRAM_STREAM_SAMPLE_RATE } from '@/lib/ama-voice'

const DEEPGRAM_AUTH_GRANT_URL = 'https://api.deepgram.com/v1/auth/grant'
const DEFAULT_DEEPGRAM_TTS_MODEL = 'aura-2-thalia-en'
const DEEPGRAM_TOKEN_TTL_SECONDS = 60

const DeepgramGrantResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().nullable().optional(),
})

export const runtime = 'nodejs'

export async function POST() {
  const apiKey = process.env.DEEPGRAM_API_KEY?.trim()
  if (!apiKey) {
    return new Response('Voice mode unavailable.', { status: 503 })
  }

  const model = process.env.DEEPGRAM_TTS_MODEL?.trim() || DEFAULT_DEEPGRAM_TTS_MODEL

  try {
    const deepgramResponse = await fetch(DEEPGRAM_AUTH_GRANT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ttl_seconds: DEEPGRAM_TOKEN_TTL_SECONDS,
      }),
      cache: 'no-store',
    })

    if (!deepgramResponse.ok) {
      console.error('[TTS TOKEN API] Deepgram grant failed', {
        status: deepgramResponse.status,
      })
      return new Response('Voice mode unavailable.', { status: 502 })
    }

    const responseBody = await deepgramResponse.json()
    const parsedBody = DeepgramGrantResponseSchema.safeParse(responseBody)

    if (!parsedBody.success) {
      console.error('[TTS TOKEN API] Invalid Deepgram grant response')
      return new Response('Voice mode unavailable.', { status: 502 })
    }

    return Response.json(
      {
        accessToken: parsedBody.data.access_token,
        expiresIn: parsedBody.data.expires_in ?? DEEPGRAM_TOKEN_TTL_SECONDS,
        model,
        encoding: DEEPGRAM_STREAM_ENCODING,
        sampleRate: DEEPGRAM_STREAM_SAMPLE_RATE,
      },
      {
        headers: {
          'Cache-Control': 'private, no-store',
        },
      },
    )
  } catch {
    console.error('[TTS TOKEN API] Deepgram grant failed', {
      status: 'network_error',
    })
    return new Response('Voice mode unavailable.', { status: 502 })
  }
}
