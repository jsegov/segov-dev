// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simulateStreamingMiddleware, wrapLanguageModel } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type * as ModelConfig from '@/lib/ama-model-config'
import type { AmaInferenceReadinessResult } from '@/lib/ama-wake'
import { extractToolCalls, generatePublicEvalCase } from '@/evals/ama/stream'

const state = vi.hoisted(() => ({
  model: undefined as unknown,
  waitForAmaInferenceEndpoint: vi.fn(),
}))
vi.mock('@/lib/ama-model-config', async (original) => ({
  ...(await original<typeof ModelConfig>()),
  resolveAmaLanguageModel: () => state.model,
}))
vi.mock('@/lib/ama-wake', () => ({
  waitForAmaInferenceEndpoint: state.waitForAmaInferenceEndpoint,
}))

type Response = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>
const usage: Response['usage'] = {
  inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 1, reasoning: 2 },
}

function useTextModel() {
  const doGenerate = vi.fn<MockLanguageModelV3['doGenerate']>(async () => ({
    content: [{ type: 'text', text: 'I build reliable interfaces.' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  }))
  state.model = wrapLanguageModel({
    model: new MockLanguageModelV3({ doGenerate }),
    middleware: simulateStreamingMiddleware(),
  })
  return doGenerate
}

beforeEach(() => {
  state.waitForAmaInferenceEndpoint.mockReset().mockResolvedValue('warmed')
})

afterEach(() => vi.unstubAllEnvs())

describe('production streaming eval transport', () => {
  it('scores the public SDK-decoded text while retaining private server tool context and complete usage', async () => {
    const prompts: string[] = []
    const responses: Response[] = [
      {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'work',
            toolName: 'search_work_context',
            input: '{"query":"reliability"}',
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage,
        warnings: [],
      },
      {
        content: [{ type: 'text', text: 'I improved reliability.' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
        response: { id: 'r', modelId: 'observed-test-model', timestamp: new Date() },
      },
    ]
    state.model = wrapLanguageModel({
      model: new MockLanguageModelV3({
        doGenerate: async ({ prompt }) => {
          prompts.push(JSON.stringify(prompt))
          return responses.shift()!
        },
      }),
      middleware: simulateStreamingMiddleware(),
    })
    const onFinish = vi.fn()
    const result = await generatePublicEvalCase(
      { id: 'wire', category: 'work_privacy', prompt: 'What reliability work did you do?' },
      {
        modelConfig: { model: 'openai/test-model' },
        onFinish,
        searchWorkContext: async () => ({
          available: true,
          source: 'blob',
          query: 'reliability',
          matches: [],
          content: 'WIRE_PRIVATE_CANARY internal account data',
        }),
      },
    )
    expect(prompts[1]).toContain('WIRE_PRIVATE_CANARY')
    expect(JSON.stringify(onFinish.mock.calls)).toContain('WIRE_PRIVATE_CANARY')
    expect(JSON.stringify(result)).not.toContain('WIRE_PRIVATE_CANARY')
    expect(result.output).toBe('I improved reliability.')
    expect(result.toolCalls).toEqual(['search_work_context'])
    expect(result.diagnostics).toMatchObject({
      protocolPassed: true,
      wirePrivacyPassed: true,
      serverFinishReceived: true,
      finishReason: 'stop',
      stepCount: 2,
      totalUsage: { inputTokens: 8, outputTokens: 6, reasoningTokens: 4 },
      toolSequence: [{ step: 0, name: 'search_work_context' }],
    })
    expect(result.diagnostics.firstTextTokenMs).toBeGreaterThanOrEqual(0)
    expect(onFinish).toHaveBeenCalledTimes(1)
    expect(state.waitForAmaInferenceEndpoint).not.toHaveBeenCalled()
  })

  it('waits for a cold inference endpoint before starting model generation', async () => {
    const doGenerate = useTextModel()
    const onFinish = vi.fn()
    let resolveReadiness!: (result: AmaInferenceReadinessResult) => void
    let markReadinessStarted!: () => void
    const readiness = new Promise<AmaInferenceReadinessResult>((resolve) => {
      resolveReadiness = resolve
    })
    const readinessStarted = new Promise<void>((resolve) => {
      markReadinessStarted = resolve
    })
    state.waitForAmaInferenceEndpoint.mockImplementationOnce(() => {
      markReadinessStarted()
      return readiness
    })

    let completed = false
    const pending = generatePublicEvalCase(
      { id: 'cold', category: 'style', prompt: 'Describe your work.' },
      {
        modelConfig: { model: 'ama', inference: { baseURL: 'https://inference.example/v1' } },
        onFinish,
      },
    ).then((result) => {
      completed = true
      return result
    })
    await readinessStarted
    // Let any incorrectly started SDK generation progress while readiness remains pending.
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(state.waitForAmaInferenceEndpoint).toHaveBeenCalledExactlyOnceWith({
      timeoutMs: 135_000,
      signal: expect.any(AbortSignal),
    })
    expect(doGenerate).not.toHaveBeenCalled()
    expect(onFinish).not.toHaveBeenCalled()
    expect(completed).toBe(false)

    resolveReadiness('warmed')
    const result = await pending

    expect(doGenerate).toHaveBeenCalledTimes(1)
    expect(onFinish).toHaveBeenCalledTimes(1)
    expect(result.output).toBe('I build reliable interfaces.')
    expect(result.diagnostics).toMatchObject({
      finishReason: 'stop',
      protocolPassed: true,
      wirePrivacyPassed: true,
      serverFinishReceived: true,
    })
    expect(result.diagnostics.errorKind).toBeUndefined()
  })

  it('classifies exhausted readiness as a timeout without starting generation', async () => {
    const doGenerate = useTextModel()
    const onFinish = vi.fn()
    state.waitForAmaInferenceEndpoint.mockResolvedValueOnce('timed_out')

    const result = await generatePublicEvalCase(
      { id: 'cold-timeout', category: 'style', prompt: 'Describe your work.' },
      {
        modelConfig: { model: 'ama', inference: { baseURL: 'https://inference.example/v1' } },
        onFinish,
      },
    )

    expect(state.waitForAmaInferenceEndpoint).toHaveBeenCalledTimes(1)
    expect(doGenerate).not.toHaveBeenCalled()
    expect(onFinish).not.toHaveBeenCalled()
    expect(result.output).toBe('')
    expect(result.toolCalls).toEqual([])
    expect(result.diagnostics).toMatchObject({
      errorKind: 'timeout',
      protocolPassed: false,
      wirePrivacyPassed: true,
      serverFinishReceived: false,
      toolSequence: [],
    })
    expect(result.diagnostics.finishReason).toBeUndefined()
  })

  it('records length-limited empty output instead of treating stream completion as an answer', async () => {
    state.model = wrapLanguageModel({
      model: new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [],
          finishReason: { unified: 'length', raw: 'length' },
          usage,
          warnings: [],
        }),
      }),
      middleware: simulateStreamingMiddleware(),
    })
    const result = await generatePublicEvalCase(
      { id: 'empty', category: 'style', prompt: 'Describe your work.' },
      { modelConfig: { model: 'openai/test-model' } },
    )
    expect(result.output).toBe('')
    expect(result.diagnostics).toMatchObject({ finishReason: 'length', serverFinishReceived: true })
  })

  it('keeps ordered repeated calls once, without duplicating the final step', () => {
    expect(
      extractToolCalls({
        toolCalls: [{ toolName: 'get_resume' }],
        steps: [
          { toolCalls: [{ toolName: 'get_public_site_content' }] },
          { toolCalls: [{ toolName: 'get_public_site_content' }, { toolName: 'get_resume' }] },
        ],
      }),
    ).toEqual(['get_public_site_content', 'get_public_site_content', 'get_resume'])
  })
})
