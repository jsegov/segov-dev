import { describe, expect, it } from 'vitest'
import { buildAmaModelRoutingEntry, rankProvidersByCost } from '@/lib/ama-routing-refresh'

describe('ama routing refresh helpers', () => {
  it('orders providers by total cost and keeps the cheapest endpoint per provider', () => {
    const ranked = rankProvidersByCost([
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
        provider_name: 'OpenAI',
        tag: 'openai',
        status: 0,
        pricing: {
          prompt: '0.10',
          completion: '0.20',
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
    ])

    expect(ranked).toEqual([
      {
        provider: 'openai',
        inputPrice: 0.1,
        outputPrice: 0.2,
        totalPrice: 0.30000000000000004,
      },
      {
        provider: 'azure',
        inputPrice: 0.4,
        outputPrice: 0.5,
        totalPrice: 0.9,
      },
    ])
  })

  it('builds a routing entry with default and fallback providers', () => {
    const entry = buildAmaModelRoutingEntry(
      [
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
      'cron',
      new Date('2026-03-14T00:00:00.000Z'),
    )

    expect(entry).toMatchObject({
      defaultProvider: 'openai',
      fallbackProvider: 'azure',
      providerOrder: ['openai', 'azure'],
      source: 'cron',
      updatedAt: '2026-03-14T00:00:00.000Z',
    })
  })
})
