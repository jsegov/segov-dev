import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get as getEdgeConfigValue } from '@vercel/edge-config'
import { createAmaSessionCookieValue, decodeAmaSessionCookieValue } from '@/lib/ama-session'
import { AMA_SESSION_COOKIE_NAME } from '@/lib/ama-routing'

vi.mock('@vercel/edge-config', () => ({
  get: vi.fn(),
}))

const getEdgeConfigValueMock = vi.mocked(getEdgeConfigValue)

describe('/api/ama/session route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.AMA_SESSION_SECRET = 'test-secret'
  })

  it('creates a signed ama session cookie from edge config routing', async () => {
    getEdgeConfigValueMock.mockResolvedValueOnce({
      version: 1,
      models: {
        'openai/gpt-5-mini': {
          defaultProvider: 'openai',
          fallbackProvider: 'azure',
          providerOrder: ['openai', 'azure'],
          source: 'cron',
          updatedAt: '2026-03-14T00:00:00.000Z',
          pricingSnapshot: [],
        },
      },
    })

    const { GET } = await import('@/app/api/ama/session/route')
    const response = await GET(new Request('http://localhost/api/ama/session'))

    expect(response.status).toBe(204)
    const cookie = response.headers.get('set-cookie')
    expect(cookie).toContain(`${AMA_SESSION_COOKIE_NAME}=`)

    const value = cookie?.match(/ama-routing-session=([^;]+)/)?.[1]
    expect(value).toBeTruthy()
    expect(decodeAmaSessionCookieValue(value!)).toMatchObject({
      primary: {
        modelId: 'openai/gpt-5-mini',
        providerOrder: ['openai', 'azure'],
      },
    })
  })

  it('reuses an existing valid ama session cookie', async () => {
    const { GET } = await import('@/app/api/ama/session/route')
    const cookieValue = createAmaSessionCookieValue({
      version: 1,
      createdAt: '2026-03-14T00:00:00.000Z',
      primary: {
        modelId: 'openai/gpt-5-mini',
        providerOrder: ['openai'],
        defaultProvider: 'openai',
      },
    })

    const response = await GET({
      headers: new Headers({
        cookie: `${AMA_SESSION_COOKIE_NAME}=${cookieValue}`,
      }),
    } as Request)

    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(getEdgeConfigValueMock).not.toHaveBeenCalled()
  })

  it('replaces an invalid ama session cookie', async () => {
    getEdgeConfigValueMock.mockResolvedValueOnce({
      version: 1,
      models: {},
    })

    const { GET } = await import('@/app/api/ama/session/route')
    const response = await GET({
      headers: new Headers({
        cookie: `${AMA_SESSION_COOKIE_NAME}=invalid.cookie`,
      }),
    } as Request)

    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toContain(`${AMA_SESSION_COOKIE_NAME}=`)
  })
})
