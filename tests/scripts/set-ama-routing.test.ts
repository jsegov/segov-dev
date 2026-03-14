import { describe, expect, it, vi } from 'vitest'

describe('set-ama-routing script', () => {
  it('parses command line arguments', async () => {
    const { parseArgs } = await import('@/scripts/set-ama-routing.mjs')

    expect(
      parseArgs([
        '--model',
        'openai/gpt-5-mini',
        '--default-provider',
        'openai',
        '--fallback-provider',
        'azure',
      ]),
    ).toEqual({
      model: 'openai/gpt-5-mini',
      defaultProvider: 'openai',
      fallbackProvider: 'azure',
    })
  })

  it('updates the edge config routing key without clobbering other models', async () => {
    const { run } = await import('@/scripts/set-ama-routing.mjs')
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
                  source: 'manual',
                  updatedAt: '2026-03-13T00:00:00.000Z',
                  pricingSnapshot: [],
                },
              },
            },
          },
        ])
      }

      if (url.includes('/edge-config/edge-config-id/items') && init?.method === 'PATCH') {
        return new Response(null, { status: 200 })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const stdout = {
      write: vi.fn(),
    }

    const nextStore = await run(
      [
        '--model',
        'openai/gpt-5-mini',
        '--default-provider',
        'openai',
        '--fallback-provider',
        'azure',
      ],
      {
        fetchFn: fetchMock,
        env: {
          AMA_EDGE_CONFIG_ID: 'edge-config-id',
          VERCEL_API_TOKEN: 'vercel-token',
        },
        now: () => new Date('2026-03-14T00:00:00.000Z'),
        stdout,
      },
    )

    expect(nextStore.models['openai/gpt-4o-mini']).toMatchObject({
      defaultProvider: 'bedrock',
      providerOrder: ['bedrock'],
    })
    expect(nextStore.models['openai/gpt-5-mini']).toMatchObject({
      defaultProvider: 'openai',
      fallbackProvider: 'azure',
      providerOrder: ['openai', 'azure'],
    })

    const patchCall = fetchMock.mock.calls.find((call) => call[1]?.method === 'PATCH')
    const body = JSON.parse(String(patchCall?.[1]?.body))

    expect(body.items[0].value.models['openai/gpt-4o-mini']).toBeTruthy()
    expect(body.items[0].value.models['openai/gpt-5-mini']).toBeTruthy()
  })
})
