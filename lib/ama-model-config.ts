export const DEFAULT_AMA_CHAT_MODEL = 'openai/gpt-5-mini'

const MODEL_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/
const PROVIDER_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface AmaModelConfig {
  model: string
  providerOptions?: {
    gateway: {
      order: string[]
      only: string[]
    }
  }
}

export function parseAmaModelId(
  configuredModel: string | undefined,
  defaultModel: string,
  variableName: string,
): string {
  const model = configuredModel?.trim()

  if (!model) {
    return defaultModel
  }

  if (!MODEL_ID_PATTERN.test(model)) {
    throw new Error(`${variableName} must use "creator/model-name" format. Received: "${model}"`)
  }

  return model
}

export function parseAmaProviderSlugs(
  configuredProviders: string | undefined,
  variableName: string,
): string[] | undefined {
  const providerList = configuredProviders?.trim()

  if (!providerList) {
    return undefined
  }

  const providers = Array.from(
    new Set(
      providerList
        .split(',')
        .map((provider) => provider.trim())
        .filter(Boolean),
    ),
  )

  if (providers.length === 0) {
    return undefined
  }

  const invalidProvider = providers.find((provider) => !PROVIDER_SLUG_PATTERN.test(provider))
  if (invalidProvider) {
    throw new Error(
      `${variableName} must be a comma-separated list of provider slugs like "openai" or "vertex,anthropic". Invalid slug: "${invalidProvider}"`,
    )
  }

  return providers
}

export function getAmaModelConfig(): AmaModelConfig {
  const model = parseAmaModelId(
    process.env.AMA_CHAT_MODEL,
    DEFAULT_AMA_CHAT_MODEL,
    'AMA_CHAT_MODEL',
  )
  const providers = parseAmaProviderSlugs(process.env.AMA_CHAT_PROVIDERS, 'AMA_CHAT_PROVIDERS')

  return createAmaModelConfig(model, providers)
}

export function createAmaModelConfig(
  model: string,
  providers: string[] | undefined,
): AmaModelConfig {
  if (!providers) {
    return { model }
  }

  return {
    model,
    providerOptions: {
      gateway: {
        order: providers,
        only: providers,
      },
    },
  }
}
