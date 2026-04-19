import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()
const consoleErrorMock = vi.spyOn(console, 'error').mockImplementation(() => {})

describe('/api/tts route', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    delete process.env.DEEPGRAM_API_KEY
    delete process.env.DEEPGRAM_TTS_MODEL
  })

  it('returns 400 for invalid payloads', async () => {
    const { POST } = await import('@/app/api/tts/route')

    const invalidJsonResponse = await POST(
      new Request('http://localhost/api/tts', {
        method: 'POST',
        body: 'not-json',
      }),
    )

    const emptyTextResponse = await POST(
      new Request('http://localhost/api/tts', {
        method: 'POST',
        body: JSON.stringify({ text: '   ' }),
      }),
    )

    expect(invalidJsonResponse.status).toBe(400)
    expect(emptyTextResponse.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 422 when normalized text exceeds the Deepgram limit', async () => {
    const { POST } = await import('@/app/api/tts/route')

    const response = await POST(
      new Request('http://localhost/api/tts', {
        method: 'POST',
        body: JSON.stringify({ text: 'x'.repeat(2001) }),
      }),
    )

    expect(response.status).toBe(422)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 503 when DEEPGRAM_API_KEY is missing', async () => {
    const { POST } = await import('@/app/api/tts/route')

    const response = await POST(
      new Request('http://localhost/api/tts', {
        method: 'POST',
        body: JSON.stringify({ text: 'Hello from Jonathan.' }),
      }),
    )

    expect(response.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps Deepgram upstream failures to 502 and logs status plus request id', async () => {
    process.env.DEEPGRAM_API_KEY = 'deepgram-key'
    fetchMock.mockResolvedValueOnce(
      new Response('upstream failure', {
        status: 429,
        headers: {
          'dg-request-id': 'dg-request-123',
        },
      }),
    )

    const { POST } = await import('@/app/api/tts/route')

    const response = await POST(
      new Request('http://localhost/api/tts', {
        method: 'POST',
        body: JSON.stringify({ text: 'Hello from Jonathan.' }),
      }),
    )

    expect(response.status).toBe(502)
    expect(consoleErrorMock).toHaveBeenCalledWith('[TTS API] Deepgram request failed', {
      status: 429,
      requestId: 'dg-request-123',
    })
  })

  it('returns an MP3 proxy response with no-store caching', async () => {
    process.env.DEEPGRAM_API_KEY = 'deepgram-key'
    process.env.DEEPGRAM_TTS_MODEL = 'aura-2-apollo-en'
    fetchMock.mockResolvedValueOnce(
      new Response('audio-bytes', {
        status: 200,
        headers: {
          'Content-Type': 'audio/mpeg',
          'dg-request-id': 'dg-request-456',
        },
      }),
    )

    const { POST } = await import('@/app/api/tts/route')

    const response = await POST(
      new Request('http://localhost/api/tts', {
        method: 'POST',
        body: JSON.stringify({ text: '  Hello   from Jonathan.  ' }),
      }),
    )

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.deepgram.com/v1/speak?model=aura-2-apollo-en&encoding=mp3'),
      {
        method: 'POST',
        headers: {
          Authorization: 'Token deepgram-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'Hello from Jonathan.' }),
        cache: 'no-store',
      },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('audio/mpeg')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.text()).toBe('audio-bytes')
  })
})
