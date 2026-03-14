import { z } from 'zod'
import { type AmaModelRouting, type AmaPricingSnapshot } from '@/lib/ama-routing'

type FetchFn = typeof fetch

const gatewayEndpointsResponseSchema = z.object({
  data: z.object({
    endpoints: z.array(
      z.object({
        provider_name: z.string().min(1),
        tag: z.string().min(1).optional(),
        status: z.number().optional().nullable(),
        pricing: z.object({
          prompt: z.string(),
          completion: z.string(),
        }),
      }),
    ),
  }),
})

type GatewayEndpoint = z.infer<typeof gatewayEndpointsResponseSchema>['data']['endpoints'][number]

export async function fetchGatewayModelEndpoints(
  modelId: string,
  fetchFn: FetchFn = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GatewayEndpoint[]> {
  const apiKey = env.AI_GATEWAY_API_KEY?.trim()
  if (!apiKey) {
    throw new Error('AI_GATEWAY_API_KEY is required')
  }

  const encodedModelId = modelId.split('/').map(encodeURIComponent).join('/')
  const response = await fetchFn(
    `https://ai-gateway.vercel.sh/v1/models/${encodedModelId}/endpoints`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      method: 'GET',
    },
  )

  if (!response.ok) {
    throw new Error(`Failed to load model endpoints for ${modelId} (${response.status})`)
  }

  const result = gatewayEndpointsResponseSchema.safeParse(await response.json())
  if (!result.success) {
    throw new Error(`Invalid model endpoints payload for ${modelId}`)
  }

  return result.data.data.endpoints
}

export function buildAmaModelRoutingEntry(
  endpoints: GatewayEndpoint[],
  source: AmaModelRouting['source'],
  now: Date = new Date(),
): AmaModelRouting | null {
  const pricingSnapshot = rankProvidersByCost(endpoints)

  if (pricingSnapshot.length === 0) {
    return null
  }

  return {
    defaultProvider: pricingSnapshot[0].provider,
    fallbackProvider: pricingSnapshot[1]?.provider,
    providerOrder: pricingSnapshot.map((item) => item.provider),
    source,
    updatedAt: now.toISOString(),
    pricingSnapshot,
  }
}

export function rankProvidersByCost(endpoints: GatewayEndpoint[]): AmaPricingSnapshot[] {
  const candidates = new Map<string, AmaPricingSnapshot>()

  for (const endpoint of endpoints) {
    const status = endpoint.status ?? 0
    if (status !== 0) {
      continue
    }

    const provider = endpoint.tag?.trim() || endpoint.provider_name.trim()
    const inputPrice = parsePrice(endpoint.pricing.prompt)
    const outputPrice = parsePrice(endpoint.pricing.completion)

    if (!provider || inputPrice === null || outputPrice === null) {
      continue
    }

    const nextCandidate = {
      provider,
      inputPrice,
      outputPrice,
      totalPrice: inputPrice + outputPrice,
    }

    const currentCandidate = candidates.get(provider)
    if (!currentCandidate || nextCandidate.totalPrice < currentCandidate.totalPrice) {
      candidates.set(provider, nextCandidate)
    }
  }

  return [...candidates.values()].sort(
    (left, right) =>
      left.totalPrice - right.totalPrice || left.provider.localeCompare(right.provider),
  )
}

function parsePrice(value: string): number | null {
  const numericValue = Number.parseFloat(value)
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return null
  }

  return numericValue
}
