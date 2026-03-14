import { NextResponse } from 'next/server'
import { buildAmaModelRoutingEntry, fetchGatewayModelEndpoints } from '@/lib/ama-routing-refresh'
import { getAmaRuntimeConfig } from '@/lib/ama-routing'
import {
  readAmaRoutingStoreFromVercelApi,
  writeAmaRoutingStoreToVercelApi,
} from '@/lib/ama-routing-store'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const runtimeConfig = getAmaRuntimeConfig()
  const currentStore = await readAmaRoutingStoreFromVercelApi()
  const nextStore = {
    ...currentStore,
    models: { ...currentStore.models },
  }

  const updatedModels: string[] = []
  const failedModels: Array<{ modelId: string; error: string }> = []

  for (const modelId of new Set(
    [runtimeConfig.defaultModelId, runtimeConfig.fallbackModelId].filter(
      (candidate): candidate is string => Boolean(candidate),
    ),
  )) {
    try {
      const endpoints = await fetchGatewayModelEndpoints(modelId)
      const routingEntry = buildAmaModelRoutingEntry(endpoints, 'cron')

      if (!routingEntry) {
        throw new Error(`No priced providers available for ${modelId}`)
      }

      nextStore.models[modelId] = routingEntry
      updatedModels.push(modelId)
    } catch (error) {
      failedModels.push({
        modelId,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  if (updatedModels.length > 0) {
    await writeAmaRoutingStoreToVercelApi(nextStore)
  }

  return NextResponse.json(
    {
      updatedModels,
      failedModels,
    },
    { status: failedModels.length > 0 ? 500 : 200 },
  )
}

function isAuthorizedCronRequest(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim()
  if (!cronSecret) {
    return false
  }

  return request.headers.get('authorization') === `Bearer ${cronSecret}`
}
