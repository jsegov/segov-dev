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

function parseAmaChatModel(): string {
  const configuredModel = process.env.AMA_CHAT_MODEL?.trim()

  if (!configuredModel) {
    return DEFAULT_AMA_CHAT_MODEL
  }

  if (!MODEL_ID_PATTERN.test(configuredModel)) {
    throw new Error(
      `AMA_CHAT_MODEL must use "creator/model-name" format. Received: "${configuredModel}"`,
    )
  }

  return configuredModel
}

function parseAmaChatProviders(): string[] | undefined {
  const configuredProviders = process.env.AMA_CHAT_PROVIDERS?.trim()

  if (!configuredProviders) {
    return undefined
  }

  const providers = Array.from(
    new Set(
      configuredProviders
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
      `AMA_CHAT_PROVIDERS must be a comma-separated list of provider slugs like "openai" or "vertex,anthropic". Invalid slug: "${invalidProvider}"`,
    )
  }

  return providers
}

export function getAmaModelConfig(): AmaModelConfig {
  const model = parseAmaChatModel()
  const providers = parseAmaChatProviders()

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
