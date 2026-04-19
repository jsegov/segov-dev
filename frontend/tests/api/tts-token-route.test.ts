import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()
const consoleErrorMock = vi.spyOn(console, 'error').mockImplementation(() => {})

describe('/api/tts/token route', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    delete process.env.DEEPGRAM_API_KEY
    delete process.env.DEEPGRAM_TTS_MODEL
  })

  it('returns 503 when DEEPGRAM_API_KEY is missing', async () => {
    const { POST } = await import('@/app/api/tts/token/route')

    const response = await POST()

    expect(response.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps Deepgram auth grant failures to 502', async () => {
    process.env.DEEPGRAM_API_KEY = 'deepgram-key'
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }))

    const { POST } = await import('@/app/api/tts/token/route')

    const response = await POST()

    expect(response.status).toBe(502)
    expect(consoleErrorMock).toHaveBeenCalledWith('[TTS TOKEN API] Deepgram grant failed', {
      status: 403,
    })
  })

  it('returns a temporary token payload for the websocket client', async () => {
    process.env.DEEPGRAM_API_KEY = 'deepgram-key'
    process.env.DEEPGRAM_TTS_MODEL = 'aura-2-apollo-en'
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'jwt-token',
          expires_in: 60,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    )

    const { POST } = await import('@/app/api/tts/token/route')

    const response = await POST()

    expect(fetchMock).toHaveBeenCalledWith('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: {
        Authorization: 'Token deepgram-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ttl_seconds: 60,
      }),
      cache: 'no-store',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      accessToken: 'jwt-token',
      expiresIn: 60,
      model: 'aura-2-apollo-en',
      encoding: 'linear16',
      sampleRate: 24000,
    })
  })
})
