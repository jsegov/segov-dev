import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { AmaModelConfig } from '@/lib/ama-model-config'

type GenerateResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>

let mockModel: MockLanguageModelV3

vi.mock('@/lib/ama-model-config', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()

  return {
    ...actual,
    resolveAmaLanguageModel: () => mockModel,
  }
})

const usage: GenerateResult['usage'] = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function createToolCall(
  toolCallId: string,
  toolName: 'search_personal_context' | 'get_public_site_content',
  input: Record<string, string> = {},
): GenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage,
    warnings: [],
  }
}

function createAnswer(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  }
}

describe('AMA agent retrieval loop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('retains current-turn results and forces text after a repeated retrieval', async () => {
    const responses = [
      createToolCall('personal-1', 'search_personal_context', { query: 'Quartz Ledger' }),
      createToolCall('public-1', 'get_public_site_content'),
      createToolCall('personal-2', 'search_personal_context', { query: 'Quartz Ledger' }),
      createAnswer('I do not have reliable context for that project. Try my Projects page.'),
    ]
    let modelCall = 0
    mockModel = new MockLanguageModelV3({
      doGenerate: async () => responses[modelCall++]!,
    })
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const modelConfig: AmaModelConfig = { model: 'openai/test-model' }
    const agent = createAmaAgent({
      modelConfig,
      getPublicSiteContent: async () => {
        throw new Error('public context unavailable')
      },
      searchPersonalContext: async (query) => ({
        available: true,
        source: 'blob',
        query,
        matches: [],
        content: 'No matching personal context was found.',
      }),
    })

    const result = await agent.generate({ prompt: 'Tell me about Quartz Ledger.' })

    expect(result.text).toContain('Projects page')
    expect(result.steps).toHaveLength(4)
    expect(mockModel.doGenerateCalls).toHaveLength(4)
    expect(mockModel.doGenerateCalls[2]?.prompt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'tool' }),
        expect.objectContaining({ role: 'tool' }),
      ]),
    )
    expect(mockModel.doGenerateCalls[3]?.toolChoice).toEqual({ type: 'none' })
  })
})
