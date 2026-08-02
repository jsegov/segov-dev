import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_AMA_CHAT_MODEL,
  getAmaModelConfig,
  parseAmaInferenceHeaders,
  parseAmaReasoningEffort,
  resolveAmaLanguageModel,
} from '@/lib/ama-model-config'

describe('getAmaModelConfig', () => {
  beforeEach(() => {
    delete process.env.AMA_CHAT_MODEL
    delete process.env.AMA_CHAT_PROVIDERS
    delete process.env.AMA_INFERENCE_BASE_URL
    delete process.env.AMA_INFERENCE_REASONING_EFFORT
    delete process.env.AMA_DEPLOYMENT_MODEL
  })

  it('returns the default model when env vars are absent', () => {
    expect(getAmaModelConfig()).toEqual({
      model: DEFAULT_AMA_CHAT_MODEL,
    })
  })

  it('returns a custom model from env', () => {
    process.env.AMA_CHAT_MODEL = 'anthropic/claude-sonnet-4'

    expect(getAmaModelConfig()).toEqual({
      model: 'anthropic/claude-sonnet-4',
    })
  })

  it('returns provider routing for a single provider slug', () => {
    process.env.AMA_CHAT_PROVIDERS = 'openai'

    expect(getAmaModelConfig()).toEqual({
      model: DEFAULT_AMA_CHAT_MODEL,
      providerOptions: {
        gateway: {
          order: ['openai'],
          only: ['openai'],
        },
      },
    })
  })

  it('trims, filters, and deduplicates multiple provider slugs', () => {
    process.env.AMA_CHAT_PROVIDERS = ' vertex, anthropic ,vertex, ,bedrock '

    expect(getAmaModelConfig()).toEqual({
      model: DEFAULT_AMA_CHAT_MODEL,
      providerOptions: {
        gateway: {
          order: ['vertex', 'anthropic', 'bedrock'],
          only: ['vertex', 'anthropic', 'bedrock'],
        },
      },
    })
  })

  it.each(['openai', 'openai/gpt 5', 'openai/gpt-5/extra'])(
    'throws for invalid AMA_CHAT_MODEL values: %s',
    (invalidModel) => {
      process.env.AMA_CHAT_MODEL = invalidModel

      expect(() => getAmaModelConfig()).toThrow(
        `AMA_CHAT_MODEL must use "creator/model-name" format. Received: "${invalidModel}"`,
      )
    },
  )

  it('throws for invalid AMA_CHAT_PROVIDERS values', () => {
    process.env.AMA_CHAT_PROVIDERS = 'openai,invalid slug'

    expect(() => getAmaModelConfig()).toThrow(
      'AMA_CHAT_PROVIDERS must be a comma-separated list of provider slugs like "openai" or "vertex,anthropic". Invalid slug: "invalid slug"',
    )
  })

  it('treats blank env values as unset', () => {
    process.env.AMA_CHAT_MODEL = '   '
    process.env.AMA_CHAT_PROVIDERS = '   '

    expect(getAmaModelConfig()).toEqual({
      model: DEFAULT_AMA_CHAT_MODEL,
    })
  })

  it('returns an inference config when AMA_INFERENCE_BASE_URL is set', () => {
    process.env.AMA_INFERENCE_BASE_URL = 'https://inference.example.com/v1'
    process.env.AMA_DEPLOYMENT_MODEL = 'tinker://run-id:train:0/sampler_weights/final'

    expect(getAmaModelConfig()).toEqual({
      model: 'tinker://run-id:train:0/sampler_weights/final',
      inference: { baseURL: 'https://inference.example.com/v1' },
    })
  })

  it('passes reasoning effort through inference providerOptions', () => {
    process.env.AMA_INFERENCE_BASE_URL = 'https://inference.example.com/v1'
    process.env.AMA_DEPLOYMENT_MODEL = 'tinker://run-id:train:0/sampler_weights/final'
    process.env.AMA_INFERENCE_REASONING_EFFORT = '0.9'

    expect(getAmaModelConfig()).toEqual({
      model: 'tinker://run-id:train:0/sampler_weights/final',
      inference: { baseURL: 'https://inference.example.com/v1' },
      providerOptions: {
        inference: { reasoning_effort: 0.9 },
      },
    })
  })

  it('throws when AMA_INFERENCE_BASE_URL is set without AMA_DEPLOYMENT_MODEL', () => {
    process.env.AMA_INFERENCE_BASE_URL = 'https://inference.example.com/v1'

    expect(() => getAmaModelConfig()).toThrow(
      'AMA_DEPLOYMENT_MODEL is required when AMA_INFERENCE_BASE_URL is set.',
    )
  })

  it('ignores AMA_CHAT_MODEL format validation on the inference path', () => {
    process.env.AMA_INFERENCE_BASE_URL = 'https://inference.example.com/v1'
    process.env.AMA_DEPLOYMENT_MODEL = 'plain-checkpoint-name'
    process.env.AMA_CHAT_MODEL = 'not a valid gateway id'

    expect(getAmaModelConfig().model).toBe('plain-checkpoint-name')
  })
})

describe('parseAmaReasoningEffort', () => {
  it('returns undefined for unset or blank values', () => {
    expect(parseAmaReasoningEffort(undefined, 'VAR')).toBeUndefined()
    expect(parseAmaReasoningEffort('   ', 'VAR')).toBeUndefined()
  })

  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])(
    'accepts the named effort %s',
    (effort) => {
      expect(parseAmaReasoningEffort(effort, 'VAR')).toBe(effort)
    },
  )

  it('parses numeric efforts within [0, 0.99]', () => {
    expect(parseAmaReasoningEffort('0', 'VAR')).toBe(0)
    expect(parseAmaReasoningEffort('0.9', 'VAR')).toBe(0.9)
    expect(parseAmaReasoningEffort('0.99', 'VAR')).toBe(0.99)
  })

  it.each(['1', '-0.1', 'highest', 'abc'])('throws for invalid effort %s', (effort) => {
    expect(() => parseAmaReasoningEffort(effort, 'VAR')).toThrow(
      /VAR must be one of none, minimal, low, medium, high, xhigh or a number/,
    )
  })
})

describe('parseAmaInferenceHeaders', () => {
  it('returns undefined for unset, blank, or empty-object values', () => {
    expect(parseAmaInferenceHeaders(undefined, 'VAR')).toBeUndefined()
    expect(parseAmaInferenceHeaders('   ', 'VAR')).toBeUndefined()
    expect(parseAmaInferenceHeaders('{}', 'VAR')).toBeUndefined()
  })

  it('parses a JSON object of header names to values', () => {
    expect(
      parseAmaInferenceHeaders('{"Modal-Key":"wk-abc","Modal-Secret":"ws-def"}', 'VAR'),
    ).toEqual({
      'Modal-Key': 'wk-abc',
      'Modal-Secret': 'ws-def',
    })
  })

  it.each(['not json', '"a string"', '[1,2]', '42'])(
    'throws for non-object JSON: %s',
    (invalid) => {
      expect(() => parseAmaInferenceHeaders(invalid, 'VAR')).toThrow(
        /VAR must be a JSON object of header names to string values/,
      )
    },
  )

  it('throws for non-string header values', () => {
    expect(() => parseAmaInferenceHeaders('{"Modal-Key":123}', 'VAR')).toThrow(
      'VAR header "Modal-Key" must have a string value.',
    )
  })
})

describe('resolveAmaLanguageModel', () => {
  beforeEach(() => {
    delete process.env.AMA_INFERENCE_HEADERS
  })

  it('returns the model id string for gateway configs', () => {
    expect(resolveAmaLanguageModel({ model: DEFAULT_AMA_CHAT_MODEL })).toBe(DEFAULT_AMA_CHAT_MODEL)
  })

  it('returns an openai-compatible chat model for inference configs', () => {
    const model = resolveAmaLanguageModel({
      model: 'tinker://run-id:train:0/sampler_weights/final',
      inference: { baseURL: 'https://inference.example.com/v1' },
    })

    expect(model).not.toBeTypeOf('string')
    expect(model).toMatchObject({
      modelId: 'tinker://run-id:train:0/sampler_weights/final',
      provider: expect.stringContaining('inference'),
    })
  })

  it('builds an inference model with AMA_INFERENCE_HEADERS set', () => {
    process.env.AMA_INFERENCE_HEADERS = '{"Modal-Key":"wk-abc","Modal-Secret":"ws-def"}'

    const model = resolveAmaLanguageModel({
      model: 'ama',
      inference: { baseURL: 'https://example.modal.run/v1' },
    })

    expect(model).toMatchObject({ modelId: 'ama' })
  })

  it('surfaces malformed AMA_INFERENCE_HEADERS at resolution time', () => {
    process.env.AMA_INFERENCE_HEADERS = 'not json'

    expect(() =>
      resolveAmaLanguageModel({
        model: 'ama',
        inference: { baseURL: 'https://example.modal.run/v1' },
      }),
    ).toThrow(/AMA_INFERENCE_HEADERS must be a JSON object/)
  })
})
