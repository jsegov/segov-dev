import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getAmaCallSettings,
  parseAmaMaxOutputTokens,
  validateAmaMaxOutputTokens,
} from '@/lib/ama-agent'
import { AmaModelConfigurationError } from '@/lib/ama-model-config'
import amaDefaults from '@/lib/ama-defaults.json'
import { getEvalCallSettings, getEvalProfile } from '@/evals/ama/profiles'
import { getEvalModelConfig } from '@/evals/ama/run'

afterEach(() => vi.unstubAllEnvs())

describe('production-faithful eval profiles', () => {
  it('shares the default and configured runtime cap without changing sampling or retries', () => {
    vi.stubEnv('AMA_MAX_OUTPUT_TOKENS', '')
    vi.stubEnv('AMA_EVAL_MAX_OUTPUT_TOKENS', '')
    const config = { model: 'openai/test' }
    expect(getEvalProfile()).toBe('production')
    expect(getEvalCallSettings(config, 'production')).toEqual({
      maxOutputTokens: amaDefaults.maxOutputTokens,
    })
    vi.stubEnv('AMA_MAX_OUTPUT_TOKENS', '1024')
    expect(getEvalCallSettings(config, 'production')).toEqual(getAmaCallSettings(config))
    expect(getEvalCallSettings(config, 'tuning', 1536)).toEqual({ maxOutputTokens: 1536 })
    expect(getEvalCallSettings(config, 'benchmark')).toEqual({
      maxOutputTokens: 2400,
      temperature: 0,
      seed: 1,
      maxRetries: 1,
    })
  })

  it.each(['0', '-1', '1.1', '1e3', 'Infinity', '9007199254740993'])(
    'rejects invalid runtime cap %s',
    (value) => {
      expect(() => parseAmaMaxOutputTokens(value)).toThrow('positive integer')
    },
  )

  it('rejects eval-specific overrides in production and tuning', () => {
    vi.stubEnv('AMA_EVAL_MAX_OUTPUT_TOKENS', '2400')
    expect(() => getEvalCallSettings({ model: 'openai/test' }, 'production')).toThrow(
      'benchmark-only',
    )
    vi.stubEnv('AMA_EVAL_MODEL', 'openai/other')
    expect(() => getEvalModelConfig('tuning')).toThrow('benchmark-only')
  })

  it.each([0, -1, 0.5, '512', null, undefined])(
    'classifies malformed defaults as configuration errors: %s',
    (value) => {
      expect(() => validateAmaMaxOutputTokens(value, 'ama-defaults.json maxOutputTokens')).toThrow(
        AmaModelConfigurationError,
      )
    },
  )

  it('inherits exact fine-tuned inference settings in the production profile', () => {
    vi.stubEnv('AMA_EVAL_MAX_OUTPUT_TOKENS', '')
    const config = { model: 'fine-tuned', inference: { baseURL: 'https://inference.example/v1' } }
    expect(getEvalCallSettings(config, 'production')).toEqual(getAmaCallSettings(config))
    expect(getEvalCallSettings(config, 'production')).toMatchObject({
      maxRetries: 0,
      temperature: 0,
      seed: 1,
    })
  })
})
