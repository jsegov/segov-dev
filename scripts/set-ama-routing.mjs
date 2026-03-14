import process from 'node:process'
import { pathToFileURL } from 'node:url'

export async function run(
  argv = process.argv.slice(2),
  { env = process.env, fetchFn = fetch, now = () => new Date(), stdout = process.stdout } = {},
) {
  const args = parseArgs(argv)
  const config = getVercelApiConfig(env)
  const currentStore = await readAmaRoutingStore(fetchFn, config)
  const nextStore = {
    version: 1,
    models: {
      ...currentStore.models,
      [args.model]: {
        defaultProvider: args.defaultProvider,
        fallbackProvider: args.fallbackProvider,
        providerOrder: [args.defaultProvider, args.fallbackProvider].filter(Boolean),
        source: 'manual',
        updatedAt: now().toISOString(),
        pricingSnapshot: [],
      },
    },
  }

  await writeAmaRoutingStore(fetchFn, config, nextStore)
  stdout.write(`Updated AMA routing for ${args.model}\n`)

  return nextStore
}

export function parseArgs(argv) {
  const values = {
    model: undefined,
    defaultProvider: undefined,
    fallbackProvider: undefined,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]

    if (arg === '--model') {
      values.model = next
      index += 1
      continue
    }

    if (arg === '--default-provider') {
      values.defaultProvider = next
      index += 1
      continue
    }

    if (arg === '--fallback-provider') {
      values.fallbackProvider = next
      index += 1
      continue
    }
  }

  if (!values.model || !values.defaultProvider) {
    throw new Error(
      'Usage: pnpm ama:routing:set --model <model> --default-provider <provider> [--fallback-provider <provider>]',
    )
  }

  return values
}

async function readAmaRoutingStore(fetchFn, config) {
  const response = await fetchFn(buildEdgeConfigItemsUrl(config), {
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
    },
    method: 'GET',
  })

  if (!response.ok) {
    throw new Error(`Failed to read Edge Config items (${response.status})`)
  }

  const items = await response.json()
  const routingItem = Array.isArray(items)
    ? items.find((item) => item?.key === 'ama-routing-v1')
    : undefined

  return parseAmaRoutingStore(routingItem?.value)
}

async function writeAmaRoutingStore(fetchFn, config, store) {
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
          key: 'ama-routing-v1',
          value: store,
        },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to update Edge Config items (${response.status})`)
  }
}

function parseAmaRoutingStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { version: 1, models: {} }
  }

  const models = value.models
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    return { version: 1, models: {} }
  }

  return {
    version: 1,
    models,
  }
}

function buildEdgeConfigItemsUrl({ edgeConfigId, teamId }) {
  const url = new URL(`https://api.vercel.com/v1/edge-config/${edgeConfigId}/items`)
  if (teamId) {
    url.searchParams.set('teamId', teamId)
  }

  return url.toString()
}

function getVercelApiConfig(env) {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unknown error'}\n`)
    process.exitCode = 1
  })
}
