import { get } from '@vercel/edge-config'
import {
  AMA_ROUTING_EDGE_CONFIG_KEY,
  createEmptyAmaRoutingStore,
  parseAmaRoutingStore,
  type AmaRoutingStore,
} from '@/lib/ama-routing'

type FetchFn = typeof fetch

interface VercelApiConfig {
  apiToken: string
  edgeConfigId: string
  teamId?: string
}

export async function readAmaRoutingStoreFromEdgeConfig(): Promise<AmaRoutingStore> {
  try {
    const value = await get(AMA_ROUTING_EDGE_CONFIG_KEY)
    return parseAmaRoutingStore(value) ?? createEmptyAmaRoutingStore()
  } catch {
    return createEmptyAmaRoutingStore()
  }
}

export async function readAmaRoutingStoreFromVercelApi(
  fetchFn: FetchFn = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AmaRoutingStore> {
  const config = getVercelApiConfig(env)
  const response = await fetchFn(buildEdgeConfigItemsUrl(config), {
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
    },
    method: 'GET',
  })

  if (!response.ok) {
    throw new Error(`Failed to read Edge Config items (${response.status})`)
  }

  const items = (await response.json()) as Array<{ key?: string; value?: unknown }>
  const amaRoutingItem = items.find((item) => item.key === AMA_ROUTING_EDGE_CONFIG_KEY)

  return parseAmaRoutingStore(amaRoutingItem?.value) ?? createEmptyAmaRoutingStore()
}

export async function writeAmaRoutingStoreToVercelApi(
  store: AmaRoutingStore,
  fetchFn: FetchFn = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = getVercelApiConfig(env)
  const response = await fetchFn(buildEdgeConfigItemsUrl(config), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      items: [
        {
          operation: 'upsert',
          key: AMA_ROUTING_EDGE_CONFIG_KEY,
          value: store,
        },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to update Edge Config items (${response.status})`)
  }
}

function buildEdgeConfigItemsUrl({ edgeConfigId, teamId }: VercelApiConfig): string {
  const url = new URL(`https://api.vercel.com/v1/edge-config/${edgeConfigId}/items`)
  if (teamId) {
    url.searchParams.set('teamId', teamId)
  }

  return url.toString()
}

function getVercelApiConfig(env: NodeJS.ProcessEnv): VercelApiConfig {
  const apiToken = env.VERCEL_API_TOKEN?.trim()
  const edgeConfigId = env.AMA_EDGE_CONFIG_ID?.trim()
  const teamId = env.VERCEL_TEAM_ID?.trim() || undefined

  if (!apiToken) {
    throw new Error('VERCEL_API_TOKEN is required')
  }

  if (!edgeConfigId) {
    throw new Error('AMA_EDGE_CONFIG_ID is required')
  }

  return {
    apiToken,
    edgeConfigId,
    teamId,
  }
}
