import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEvalModelConfig, runAmaEvalSuite } from '@/evals/ama/run'
import { generatePublicEvalCase } from '@/evals/ama/stream'
import type * as AmaStreamModule from '@/evals/ama/stream'
import { scoreAmaEvalCase } from '@/evals/ama/scorers'
import type * as AmaScorersModule from '@/evals/ama/scorers'
import { AmaModelConfigurationError, DEFAULT_AMA_CHAT_MODEL } from '@/lib/ama-model-config'

vi.mock('@/evals/ama/stream', async (importOriginal) => ({
  ...(await importOriginal<typeof AmaStreamModule>()),
  generatePublicEvalCase: vi.fn(),
}))

vi.mock('@/evals/ama/scorers', async (importOriginal) => ({
  ...(await importOriginal<typeof AmaScorersModule>()),
  scoreAmaEvalCase: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  for (const name of [
    'AMA_CHAT_MODEL',
    'AMA_CHAT_PROVIDERS',
    'AMA_INFERENCE_BASE_URL',
    'AMA_DEPLOYMENT_MODEL',
    'AMA_INFERENCE_REASONING_EFFORT',
    'AMA_EVAL_MODEL',
    'AMA_EVAL_PROVIDERS',
    'AMA_EVAL_REQUIRE_BINDINGS',
    'AMA_EVAL_CANDIDATE_ID',
    'AMA_EVAL_CHECKPOINT_PATH',
    'AMA_EVAL_MODEL_ARTIFACT_SHA256',
    'AMA_EVAL_SERVING_CONFIG_SHA256',
  ]) {
    vi.stubEnv(name, '')
  }
  vi.stubEnv('AMA_EVAL_CI', '1')
  vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key')
})

afterEach(() => vi.unstubAllEnvs())

describe('AMA CI subject configuration preflight', () => {
  it.each([undefined, '', ' \t '])(
    'rejects an absent or blank runtime model before generation or judging: %s',
    async (model) => {
      vi.stubEnv('AMA_CHAT_MODEL', model)

      await expect(
        runAmaEvalSuite({ profile: 'production', writeArtifacts: false }),
      ).rejects.toThrow('AMA CI evaluations require an explicit AMA_CHAT_MODEL')
      expect(generatePublicEvalCase).not.toHaveBeenCalled()
      expect(scoreAmaEvalCase).not.toHaveBeenCalled()
    },
  )

  it.each([
    { baseUrl: 'https://inference.example/v1', deployment: '', gateway: '' },
    { baseUrl: '', deployment: 'checkpoint-alias', gateway: '' },
    { baseUrl: 'https://inference.example/v1', deployment: ' ', gateway: 'openai/ci-model' },
    { baseUrl: ' ', deployment: 'checkpoint-alias', gateway: 'openai/ci-model' },
  ])('rejects a partial inference configuration before model work: %j', async (config) => {
    vi.stubEnv('AMA_INFERENCE_BASE_URL', config.baseUrl)
    vi.stubEnv('AMA_DEPLOYMENT_MODEL', config.deployment)
    vi.stubEnv('AMA_CHAT_MODEL', config.gateway)

    await expect(runAmaEvalSuite({ profile: 'production', writeArtifacts: false })).rejects.toThrow(
      'require both AMA_INFERENCE_BASE_URL and AMA_DEPLOYMENT_MODEL',
    )
    expect(generatePublicEvalCase).not.toHaveBeenCalled()
    expect(scoreAmaEvalCase).not.toHaveBeenCalled()
  })

  it('accepts an explicit Gateway model and preserves its routing configuration', () => {
    vi.stubEnv('AMA_CHAT_MODEL', ' openai/ci-model ')
    vi.stubEnv('AMA_CHAT_PROVIDERS', 'openai')

    expect(getEvalModelConfig('production')).toEqual({
      model: 'openai/ci-model',
      providerOptions: { gateway: { order: ['openai'], only: ['openai'] } },
    })
  })

  it.each(['', 'openai/ci-model'])(
    'accepts paired custom inference settings and preserves runtime precedence: %s',
    (gatewayModel) => {
      vi.stubEnv('AMA_CHAT_MODEL', gatewayModel)
      vi.stubEnv('AMA_INFERENCE_BASE_URL', ' https://inference.example/v1 ')
      vi.stubEnv('AMA_DEPLOYMENT_MODEL', ' checkpoint-alias ')
      vi.stubEnv('AMA_INFERENCE_REASONING_EFFORT', 'low')

      expect(getEvalModelConfig('production')).toEqual({
        model: 'checkpoint-alias',
        inference: { baseURL: 'https://inference.example/v1' },
        providerOptions: { inference: { reasoning_effort: 'low' } },
      })
    },
  )

  it('does not let a benchmark-only model satisfy explicit runtime selection', () => {
    vi.stubEnv('AMA_EVAL_MODEL', 'openai/benchmark-model')

    expect(() => getEvalModelConfig('benchmark')).toThrow(AmaModelConfigurationError)

    vi.stubEnv('AMA_CHAT_MODEL', 'openai/ci-model')
    expect(getEvalModelConfig('benchmark')).toEqual({ model: 'openai/benchmark-model' })
  })

  it('retains ordinary local production defaults', () => {
    vi.stubEnv('AMA_EVAL_CI', '')

    expect(getEvalModelConfig('production')).toMatchObject({ model: DEFAULT_AMA_CHAT_MODEL })
  })

  it('still validates explicit Gateway model syntax', () => {
    vi.stubEnv('AMA_CHAT_MODEL', 'invalid-model')

    expect(() => getEvalModelConfig('production')).toThrow('creator/model-name')
  })
})
