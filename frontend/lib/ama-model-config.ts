import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'

export const DEFAULT_AMA_CHAT_MODEL = 'openai/gpt-5-mini'

/**
 * providerOptions key for the OpenAI-compatible inference path. Unknown fields
 * under this key are passed through verbatim into the request body by
 * `@ai-sdk/openai-compatible`, which is how `reasoning_effort` reaches the
 * endpoint.
 */
export const AMA_INFERENCE_PROVIDER_NAME = 'inference'

const MODEL_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/
const PROVIDER_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const NAMED_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const

export interface AmaModelConfig {
  model: string
  /**
   * When set, `model` is served by this OpenAI-compatible endpoint instead of
   * the AI Gateway. Deliberately excludes the API key so the config stays
   * safe to serialize into eval artifacts; the key is read from
   * `AMA_INFERENCE_API_KEY` at resolution time.
   */
  inference?: {
    baseURL: string
  }
  providerOptions?: {
    gateway?: {
      order: string[]
      only: string[]
    }
    [AMA_INFERENCE_PROVIDER_NAME]?: {
      reasoning_effort: string | number
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

export function parseAmaReasoningEffort(
  configuredEffort: string | undefined,
  variableName: string,
): string | number | undefined {
  const effort = configuredEffort?.trim()

  if (!effort) {
    return undefined
  }

  if ((NAMED_REASONING_EFFORTS as readonly string[]).includes(effort)) {
    return effort
  }

  const numericEffort = Number(effort)
  if (Number.isFinite(numericEffort) && numericEffort >= 0 && numericEffort <= 0.99) {
    return numericEffort
  }

  throw new Error(
    `${variableName} must be one of ${NAMED_REASONING_EFFORTS.join(', ')} or a number in [0, 0.99]. Received: "${configuredEffort}"`,
  )
}

export function getAmaModelConfig(): AmaModelConfig {
  const inferenceBaseUrl = process.env.AMA_INFERENCE_BASE_URL?.trim()

  if (inferenceBaseUrl) {
    const model = process.env.AMA_DEPLOYMENT_MODEL?.trim()
    if (!model) {
      throw new Error('AMA_DEPLOYMENT_MODEL is required when AMA_INFERENCE_BASE_URL is set.')
    }

    return createAmaInferenceModelConfig({
      model,
      baseURL: inferenceBaseUrl,
      reasoningEffort: parseAmaReasoningEffort(
        process.env.AMA_INFERENCE_REASONING_EFFORT,
        'AMA_INFERENCE_REASONING_EFFORT',
      ),
    })
  }

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

export function createAmaInferenceModelConfig(options: {
  model: string
  baseURL: string
  reasoningEffort?: string | number
}): AmaModelConfig {
  const config: AmaModelConfig = {
    model: options.model,
    inference: { baseURL: options.baseURL },
  }

  if (options.reasoningEffort !== undefined) {
    config.providerOptions = {
      [AMA_INFERENCE_PROVIDER_NAME]: { reasoning_effort: options.reasoningEffort },
    }
  }

  return config
}

/**
 * Turns a config into the value handed to the AI SDK. Gateway configs stay
 * plain model-id strings (resolved by the SDK's default gateway provider);
 * inference configs become an `@ai-sdk/openai-compatible` chat model bound to
 * the configured endpoint.
 */
export function resolveAmaLanguageModel(config: AmaModelConfig): LanguageModel {
  if (!config.inference) {
    return config.model
  }

  const provider = createOpenAICompatible({
    name: AMA_INFERENCE_PROVIDER_NAME,
    baseURL: config.inference.baseURL,
    apiKey: process.env.AMA_INFERENCE_API_KEY,
  })

  return provider(config.model)
}
