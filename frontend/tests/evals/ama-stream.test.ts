// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  simulateStreamingMiddleware,
  stepCountIs,
  tool,
  ToolLoopAgent,
  wrapLanguageModel,
} from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'
import type * as ModelConfig from '@/lib/ama-model-config'
import type { AmaInferenceReadinessResult } from '@/lib/ama-wake'
import {
  extractGenerationDiagnostics,
  extractToolCalls,
  extractToolOutcomes,
  generatePublicEvalCase,
} from '@/evals/ama/stream'

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
      toolOutcomes: [
        {
          step: 0,
          name: 'search_work_context',
          invalid: false,
          executed: true,
          status: 'found',
        },
      ],
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

  it('distinguishes invalid, completed, and rejected repeated calls in the actual SDK loop', async () => {
    const responses: Response[] = [
      ...[
        ['private-invalid-id', '{"query":null}'],
        ['private-valid-id', '{"query":"reliability"}'],
        ['private-repeat-id', '{"query":"private-repeat-query"}'],
      ].map(
        ([toolCallId, input]): Response => ({
          content: [{ type: 'tool-call', toolCallId, toolName: 'search_work_context', input }],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage,
          warnings: [],
        }),
      ),
      {
        content: [{ type: 'text', text: 'I improved reliability.' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      },
    ]
    state.model = wrapLanguageModel({
      model: new MockLanguageModelV3({ doGenerate: async () => responses.shift()! }),
      middleware: simulateStreamingMiddleware(),
    })
    const searchWorkContext = vi.fn(async () => ({
      available: true,
      source: 'blob' as const,
      query: 'private-result-query',
      matches: [],
      content: 'PRIVATE_OUTCOME_CANARY I improved reliability.',
    }))

    const result = await generatePublicEvalCase(
      { id: 'outcomes', category: 'work_privacy', prompt: 'What reliability work did you do?' },
      { modelConfig: { model: 'openai/test-model' }, searchWorkContext },
    )

    expect(searchWorkContext).toHaveBeenCalledExactlyOnceWith('reliability')
    expect(result.toolCalls).toEqual([
      'search_work_context',
      'search_work_context',
      'search_work_context',
    ])
    expect(result.diagnostics.toolSequence).toEqual([
      { step: 0, name: 'search_work_context' },
      { step: 1, name: 'search_work_context' },
      { step: 2, name: 'search_work_context' },
    ])
    expect(result.diagnostics.toolOutcomes).toEqual([
      {
        step: 0,
        name: 'search_work_context',
        invalid: true,
        executed: false,
        status: 'not_executed',
      },
      { step: 1, name: 'search_work_context', invalid: false, executed: true, status: 'found' },
      {
        step: 2,
        name: 'search_work_context',
        invalid: true,
        executed: false,
        status: 'not_executed',
      },
    ])
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_OUTCOME_CANARY|private-/)
  })
})

describe('allowlisted tool outcome diagnostics', () => {
  it('records a real SDK execution exception as executed without leaking the exception', async () => {
    const responses: Response[] = [
      {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'private-execution-id',
            toolName: 'search_work_context',
            input: '{"query":"private-query"}',
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage,
        warnings: [],
      },
      {
        content: [{ type: 'text', text: 'Please check my Career page.' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      },
    ]
    const execute = vi.fn(async (_input: { query: string }): Promise<{ available: boolean }> => {
      throw new Error('PRIVATE_EXECUTION_EXCEPTION')
    })
    const agent = new ToolLoopAgent({
      model: new MockLanguageModelV3({ doGenerate: async () => responses.shift()! }),
      stopWhen: stepCountIs(2),
      tools: {
        search_work_context: tool({ inputSchema: z.object({ query: z.string() }), execute }),
      },
    })

    const result = await agent.generate({ prompt: 'What reliability work did you do?' })
    const diagnostics = extractGenerationDiagnostics(result)

    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.steps[0].toolResults).toEqual([])
    expect(result.steps[0].content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool-error' })]),
    )
    expect(diagnostics.toolOutcomes).toEqual([
      { step: 0, name: 'search_work_context', invalid: false, executed: true, status: 'error' },
    ])
    expect(JSON.stringify(diagnostics)).not.toMatch(/PRIVATE|private-/)
  })

  it('correlates execution errors by ID and name without copying private error fields', () => {
    const snapshot = {
      steps: [
        {
          toolCalls: [
            { toolName: 'search_work_context', toolCallId: 'private-thrown', input: 'PRIVATE' },
            { toolName: 'search_personal_context', toolCallId: 'private-pending' },
            { toolName: 'get_resume', toolCallId: 'private-invalid', invalid: true },
            { toolName: 'get_public_site_content' },
            { toolName: 'PRIVATE_UNKNOWN_TOOL', toolCallId: 'private-unknown' },
          ],
          toolResults: [
            {
              toolName: 'get_resume',
              toolCallId: 'private-invalid',
              output: { available: true, content: 'PRIVATE_INVALID_RESULT' },
            },
          ],
          content: [
            {
              type: 'tool-error',
              toolName: 'search_work_context',
              toolCallId: 'private-thrown',
              error: new Error('PRIVATE_THROWN_ERROR'),
            },
            {
              type: 'tool-error',
              toolName: 'get_resume',
              toolCallId: 'private-invalid',
              error: 'PRIVATE_PARSE_ERROR',
            },
            // An error for another tool or ID must not mark a pending call executed.
            { type: 'tool-error', toolName: 'get_resume', toolCallId: 'private-pending' },
            { type: 'tool-error', toolName: 'search_personal_context', toolCallId: 'other' },
          ],
        },
      ],
    }

    const diagnostics = extractGenerationDiagnostics(snapshot)

    expect(diagnostics.toolOutcomes).toEqual([
      { step: 0, name: 'search_work_context', invalid: false, executed: true, status: 'error' },
      {
        step: 0,
        name: 'search_personal_context',
        invalid: false,
        executed: false,
        status: 'not_executed',
      },
      { step: 0, name: 'get_resume', invalid: true, executed: false, status: 'not_executed' },
      {
        step: 0,
        name: 'get_public_site_content',
        invalid: false,
        executed: false,
        status: 'not_executed',
      },
    ])
    expect(JSON.stringify(diagnostics)).not.toMatch(/PRIVATE|private-|other/)
    expect(extractToolCalls(snapshot)).toContain('PRIVATE_UNKNOWN_TOOL')
  })

  it.each([
    [{ available: true, source: 'blob', content: 'PRIVATE_FOUND' }, 'found'],
    [{ available: false, source: 'no_matches', content: 'PRIVATE_FALLBACK' }, 'no_match'],
    [{ available: false, source: 'empty_blob', content: 'PRIVATE_FALLBACK' }, 'empty'],
    [{ available: false, source: 'empty_files', content: 'PRIVATE_FALLBACK' }, 'empty'],
    [{ available: false, source: 'blob_fetch_failed', content: 'PRIVATE_FALLBACK' }, 'unavailable'],
    [{ available: true, source: 'blob', content: ' \n ' }, 'empty'],
    [
      { available: true, sourceKind: 'work', retrievalStatus: 'found', content: 'PRIVATE_FOUND' },
      'found',
    ],
    [
      {
        available: false,
        sourceKind: 'work',
        retrievalStatus: 'no_match',
        content: 'PRIVATE_FALLBACK',
      },
      'no_match',
    ],
    [{ available: false, sourceKind: 'resume', retrievalStatus: 'empty' }, 'empty'],
    [
      { available: false, retrievalStatus: 'unavailable', content: 'PRIVATE_FALLBACK' },
      'unavailable',
    ],
    [{ available: false, retrievalStatus: 'found', content: 'PRIVATE_FALLBACK' }, 'unavailable'],
    [{ type: 'json', value: { available: true, content: 'PRIVATE_WRAPPED' } }, 'unavailable'],
    ['PRIVATE_UNEXPECTED_OUTPUT', 'unavailable'],
    [null, 'unavailable'],
  ])('classifies raw result %j as %s without exposing it', (output, status) => {
    const snapshot = {
      toolCalls: [{ toolName: 'get_resume', toolCallId: 'private-id' }],
      toolResults: [{ toolName: 'get_resume', toolCallId: 'private-id', output }],
    }
    expect(extractToolOutcomes(snapshot)).toEqual([
      { step: 0, name: 'get_resume', invalid: false, executed: true, status },
    ])
    expect(JSON.stringify(extractToolOutcomes(snapshot))).not.toMatch(/PRIVATE|private-/)
  })

  it('does not reuse earlier results or count the final-step shortcut twice', () => {
    const snapshot = {
      toolCalls: [{ toolName: 'get_resume', toolCallId: 'same-id' }],
      steps: [
        {
          toolCalls: [{ toolName: 'get_resume', toolCallId: 'same-id' }],
          toolResults: [
            {
              toolName: 'get_resume',
              toolCallId: 'same-id',
              output: { available: true, content: 'PRIVATE_FOUND' },
            },
          ],
        },
        { toolCalls: [{ toolName: 'get_resume', toolCallId: 'same-id' }] },
      ],
    }
    expect(extractToolOutcomes(snapshot)).toEqual([
      { step: 0, name: 'get_resume', invalid: false, executed: true, status: 'found' },
      { step: 1, name: 'get_resume', invalid: false, executed: false, status: 'not_executed' },
    ])
  })

  it.each(['found', 'no_match', 'empty', 'unavailable'] as const)(
    'preserves reused %s results and every attempt without counting another loader execution',
    (status) => {
      const output = {
        available: status === 'found',
        retrievalStatus: status,
        sourceKind: 'work',
        content: 'PRIVATE_REUSED_CONTENT',
      }
      const snapshot = {
        steps: [
          {
            toolCalls: [
              { toolName: 'search_work_context', toolCallId: 'private-first' },
              { toolName: 'search_work_context', toolCallId: 'private-reused' },
              { toolName: 'search_work_context', toolCallId: 'private-invalid', invalid: true },
            ],
            toolResults: [
              {
                toolName: 'search_work_context',
                toolCallId: 'private-first',
                output: { ...output, executionStatus: 'executed' },
              },
              {
                toolName: 'search_work_context',
                toolCallId: 'private-reused',
                output: { ...output, executionStatus: 'reused' },
              },
              {
                toolName: 'search_work_context',
                toolCallId: 'private-invalid',
                output: { ...output, executionStatus: 'reused' },
              },
            ],
          },
        ],
      }

      const outcomes = extractToolOutcomes(snapshot)
      expect(outcomes).toEqual([
        { step: 0, name: 'search_work_context', invalid: false, executed: true, status },
        { step: 0, name: 'search_work_context', invalid: false, executed: false, status },
        {
          step: 0,
          name: 'search_work_context',
          invalid: true,
          executed: false,
          status: 'not_executed',
        },
      ])
      expect(outcomes.filter((outcome) => outcome.executed)).toHaveLength(1)
      expect(extractToolCalls(snapshot)).toEqual([
        'search_work_context',
        'search_work_context',
        'search_work_context',
      ])
      expect(JSON.stringify(outcomes)).not.toMatch(/PRIVATE|private-/)
    },
  )
})
