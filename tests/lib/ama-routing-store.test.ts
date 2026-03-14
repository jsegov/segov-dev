import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get as getEdgeConfigValue } from '@vercel/edge-config'
import { readAmaRoutingStoreFromEdgeConfig } from '@/lib/ama-routing-store'

vi.mock('@vercel/edge-config', () => ({
  get: vi.fn(),
}))

const getEdgeConfigValueMock = vi.mocked(getEdgeConfigValue)

describe('readAmaRoutingStoreFromEdgeConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the parsed ama routing store when edge config is valid', async () => {
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

    await expect(readAmaRoutingStoreFromEdgeConfig()).resolves.toMatchObject({
      models: {
        'openai/gpt-5-mini': {
          defaultProvider: 'openai',
          providerOrder: ['openai', 'azure'],
        },
      },
    })
  })

  it('falls back to an empty store when edge config is invalid', async () => {
    getEdgeConfigValueMock.mockResolvedValueOnce({
      version: 'invalid',
    })

    await expect(readAmaRoutingStoreFromEdgeConfig()).resolves.toEqual({
      version: 1,
      models: {},
    })
  })

  it('falls back to an empty store when the edge config read throws', async () => {
    getEdgeConfigValueMock.mockRejectedValueOnce(new Error('edge config unavailable'))

    await expect(readAmaRoutingStoreFromEdgeConfig()).resolves.toEqual({
      version: 1,
      models: {},
    })
  })
})
