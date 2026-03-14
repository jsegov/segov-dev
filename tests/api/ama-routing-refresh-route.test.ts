import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('/api/ama/routing/refresh route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'cron-secret'
    process.env.AI_GATEWAY_API_KEY = 'gateway-key'
    process.env.VERCEL_API_TOKEN = 'vercel-token'
    process.env.AMA_EDGE_CONFIG_ID = 'edge-config-id'
    process.env.AMA_DEFAULT_MODEL = 'openai/gpt-5-mini'
    process.env.AMA_FALLBACK_MODEL = 'openai/gpt-4o-mini'
  })

  it('returns 401 for unauthorized requests', async () => {
    const { GET } = await import('@/app/api/ama/routing/refresh/route')
    const response = await GET(new Request('http://localhost/api/ama/routing/refresh'))

    expect(response.status).toBe(401)
  })

  it('refreshes provider routing ordered by cost and writes edge config', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)

      if (url.includes('/edge-config/edge-config-id/items') && init?.method === 'GET') {
        return Response.json([
          {
            key: 'ama-routing-v1',
            value: {
              version: 1,
              models: {},
            },
          },
        ])
      }

      if (url.includes('/models/openai/gpt-5-mini/endpoints')) {
        return Response.json({
          data: {
            endpoints: [
              {
                provider_name: 'OpenAI',
                tag: 'openai',
                status: 0,
                pricing: {
                  prompt: '0.20',
                  completion: '0.30',
                },
              },
              {
                provider_name: 'Azure',
                tag: 'azure',
                status: 0,
                pricing: {
                  prompt: '0.40',
                  completion: '0.50',
                },
              },
            ],
          },
        })
      }

      if (url.includes('/models/openai/gpt-4o-mini/endpoints')) {
        return Response.json({
          data: {
            endpoints: [
              {
                provider_name: 'Anthropic',
                tag: 'anthropic',
                status: 0,
                pricing: {
                  prompt: '0.10',
                  completion: '0.20',
                },
              },
              {
                provider_name: 'Bedrock',
                tag: 'bedrock',
                status: 0,
                pricing: {
                  prompt: '0.60',
                  completion: '0.70',
                },
              },
            ],
          },
        })
      }

      if (url.includes('/edge-config/edge-config-id/items') && init?.method === 'PATCH') {
        return new Response(null, { status: 200 })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    const { GET } = await import('@/app/api/ama/routing/refresh/route')
    const response = await GET(
      new Request('http://localhost/api/ama/routing/refresh', {
        headers: {
          authorization: 'Bearer cron-secret',
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(4)

    const patchCall = fetchMock.mock.calls.find((call) => {
      const init = call[1]
      return (
        String(call[0]).includes('/edge-config/edge-config-id/items') && init?.method === 'PATCH'
      )
    })

    expect(patchCall).toBeTruthy()
    const body = JSON.parse(String(patchCall?.[1]?.body))
    expect(body.items[0].value.models['openai/gpt-5-mini']).toMatchObject({
      defaultProvider: 'openai',
      fallbackProvider: 'azure',
      providerOrder: ['openai', 'azure'],
    })
    expect(body.items[0].value.models['openai/gpt-4o-mini']).toMatchObject({
      defaultProvider: 'anthropic',
      fallbackProvider: 'bedrock',
      providerOrder: ['anthropic', 'bedrock'],
    })

    vi.unstubAllGlobals()
  })

  it('preserves the last known good routing when one model refresh fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)

      if (url.includes('/edge-config/edge-config-id/items') && init?.method === 'GET') {
        return Response.json([
          {
            key: 'ama-routing-v1',
            value: {
              version: 1,
              models: {
                'openai/gpt-4o-mini': {
                  defaultProvider: 'bedrock',
                  providerOrder: ['bedrock'],
                  source: 'cron',
                  updatedAt: '2026-03-13T00:00:00.000Z',
                  pricingSnapshot: [],
                },
              },
            },
          },
        ])
      }

      if (url.includes('/models/openai/gpt-5-mini/endpoints')) {
        return Response.json({
          data: {
            endpoints: [
              {
                provider_name: 'OpenAI',
                tag: 'openai',
                status: 0,
                pricing: {
                  prompt: '0.20',
                  completion: '0.30',
                },
              },
            ],
          },
        })
      }

      if (url.includes('/models/openai/gpt-4o-mini/endpoints')) {
        return new Response('upstream error', { status: 500 })
      }

      if (url.includes('/edge-config/edge-config-id/items') && init?.method === 'PATCH') {
        return new Response(null, { status: 200 })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    const { GET } = await import('@/app/api/ama/routing/refresh/route')
    const response = await GET(
      new Request('http://localhost/api/ama/routing/refresh', {
        headers: {
          authorization: 'Bearer cron-secret',
        },
      }),
    )

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.failedModels).toHaveLength(1)

    const patchCall = fetchMock.mock.calls.find((call) => {
      const init = call[1]
      return (
        String(call[0]).includes('/edge-config/edge-config-id/items') && init?.method === 'PATCH'
      )
    })

    const payload = JSON.parse(String(patchCall?.[1]?.body))
    expect(payload.items[0].value.models['openai/gpt-4o-mini']).toMatchObject({
      defaultProvider: 'bedrock',
      providerOrder: ['bedrock'],
    })

    vi.unstubAllGlobals()
  })
})
