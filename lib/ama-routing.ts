import { z } from 'zod'

export const AMA_ROUTING_EDGE_CONFIG_KEY = 'ama-routing-v1'
export const AMA_SESSION_COOKIE_NAME = 'ama-routing-session'
export const DEFAULT_AMA_MODEL = 'openai/gpt-5-mini'

const amaPricingSnapshotSchema = z.object({
  provider: z.string().min(1),
  inputPrice: z.number().nonnegative(),
  outputPrice: z.number().nonnegative(),
  totalPrice: z.number().nonnegative(),
})

const amaModelRoutingSchema = z.object({
  defaultProvider: z.string().min(1),
  fallbackProvider: z.string().min(1).optional(),
  providerOrder: z.array(z.string().min(1)).min(1),
  source: z.enum(['manual', 'cron']),
  updatedAt: z.string().datetime(),
  pricingSnapshot: z.array(amaPricingSnapshotSchema).default([]),
})

export const amaRoutingStoreSchema = z.object({
  version: z.literal(1),
  models: z.record(z.string(), amaModelRoutingSchema),
})

const amaSessionModelRouteSchema = z.object({
  modelId: z.string().min(1),
  providerOrder: z.array(z.string().min(1)),
  defaultProvider: z.string().min(1).optional(),
  fallbackProvider: z.string().min(1).optional(),
})

export const amaSessionSnapshotSchema = z.object({
  version: z.literal(1),
  createdAt: z.string().datetime(),
  primary: amaSessionModelRouteSchema,
  fallback: amaSessionModelRouteSchema.optional(),
})

export type AmaPricingSnapshot = z.infer<typeof amaPricingSnapshotSchema>
export type AmaModelRouting = z.infer<typeof amaModelRoutingSchema>
export type AmaRoutingStore = z.infer<typeof amaRoutingStoreSchema>
export type AmaSessionModelRoute = z.infer<typeof amaSessionModelRouteSchema>
export type AmaSessionSnapshot = z.infer<typeof amaSessionSnapshotSchema>

export interface AmaRuntimeConfig {
  defaultModelId: string
  fallbackModelId?: string
}

export function createEmptyAmaRoutingStore(): AmaRoutingStore {
  return {
    version: 1,
    models: {},
  }
}

export function parseAmaRoutingStore(value: unknown): AmaRoutingStore | null {
  const result = amaRoutingStoreSchema.safeParse(value)
  if (!result.success) {
    return null
  }

  return result.data
}

export function getAmaRuntimeConfig(): AmaRuntimeConfig {
  const defaultModelId = process.env.AMA_DEFAULT_MODEL?.trim() || DEFAULT_AMA_MODEL
  const fallbackModelId = process.env.AMA_FALLBACK_MODEL?.trim() || undefined

  return {
    defaultModelId,
    fallbackModelId:
      fallbackModelId && fallbackModelId !== defaultModelId ? fallbackModelId : undefined,
  }
}

export function buildAmaSessionSnapshot(
  store: AmaRoutingStore,
  now: Date = new Date(),
): AmaSessionSnapshot {
  const runtimeConfig = getAmaRuntimeConfig()

  return {
    version: 1,
    createdAt: now.toISOString(),
    primary: createAmaSessionModelRoute(runtimeConfig.defaultModelId, store.models),
    fallback: runtimeConfig.fallbackModelId
      ? createAmaSessionModelRoute(runtimeConfig.fallbackModelId, store.models)
      : undefined,
  }
}

export function createAmaSessionModelRoute(
  modelId: string,
  models: AmaRoutingStore['models'],
): AmaSessionModelRoute {
  const routing = models[modelId]
  const providerOrder = routing?.providerOrder?.length
    ? routing.providerOrder
    : [routing?.defaultProvider, routing?.fallbackProvider].filter((provider): provider is string =>
        Boolean(provider),
      )

  return {
    modelId,
    providerOrder,
    defaultProvider: routing?.defaultProvider,
    fallbackProvider: routing?.fallbackProvider,
  }
}
