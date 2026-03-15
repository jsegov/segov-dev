import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_AMA_CHAT_MODEL, getAmaModelConfig } from '@/lib/ama-model-config'

describe('getAmaModelConfig', () => {
  beforeEach(() => {
    delete process.env.AMA_CHAT_MODEL
    delete process.env.AMA_CHAT_PROVIDERS
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
})
