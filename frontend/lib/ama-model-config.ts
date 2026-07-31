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

export function parseAmaInferenceHeaders(
  configuredHeaders: string | undefined,
  variableName: string,
): Record<string, string> | undefined {
  const raw = configuredHeaders?.trim()

  if (!raw) {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      `${variableName} must be a JSON object of header names to string values, e.g. {"Modal-Key":"wk-...","Modal-Secret":"ws-..."}.`,
    )
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${variableName} must be a JSON object of header names to string values, e.g. {"Modal-Key":"wk-...","Modal-Secret":"ws-..."}.`,
    )
  }

  const entries = Object.entries(parsed)
  const invalidEntry = entries.find(([, value]) => typeof value !== 'string')
  if (invalidEntry) {
    throw new Error(
      `${variableName} header "${invalidEntry[0]}" must have a string value.`,
    )
  }

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
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
 *
 * Credentials are read from the env here, not stored in the config (which is
 * serialized into eval artifacts). Two auth shapes, composable:
 * - `AMA_INFERENCE_API_KEY` -> `Authorization: Bearer <key>` (Tinker, vLLM
 *   `--api-key`, any Bearer-style endpoint).
 * - `AMA_INFERENCE_HEADERS` -> verbatim custom headers, for endpoints whose
 *   auth is not Bearer-shaped — e.g. Modal proxy auth, which requires
 *   `{"Modal-Key":"wk-...","Modal-Secret":"ws-..."}` and rejects Bearer.
 */
export function resolveAmaLanguageModel(config: AmaModelConfig): LanguageModel {
  if (!config.inference) {
    return config.model
  }

  const provider = createOpenAICompatible({
    name: AMA_INFERENCE_PROVIDER_NAME,
    baseURL: config.inference.baseURL,
    apiKey: process.env.AMA_INFERENCE_API_KEY,
    headers: parseAmaInferenceHeaders(
      process.env.AMA_INFERENCE_HEADERS,
      'AMA_INFERENCE_HEADERS',
    ),
  })

  return provider(config.model)
}
