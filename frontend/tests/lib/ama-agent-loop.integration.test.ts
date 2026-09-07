import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvalidToolInputError, NoSuchToolError, stepCountIs } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { AmaAgentSettings, CreateAmaAgentOptions } from '@/lib/ama-agent'
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
  toolName: string,
  input: Record<string, unknown> | string = {},
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

function setModelResponses(responses: GenerateResult[]) {
  let modelCall = 0
  mockModel = new MockLanguageModelV3({
    doGenerate: async () => {
      const response = responses[modelCall++]
      if (!response) {
        throw new Error('Unexpected extra model call')
      }
      return response
    },
  })
}

function availableTools(callIndex: number) {
  return mockModel.doGenerateCalls[callIndex]?.tools?.map((tool) => tool.name) ?? []
}

function toolResults(callIndex: number) {
  return (
    mockModel.doGenerateCalls[callIndex]?.prompt
      .filter((message) => message.role === 'tool')
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'tool-result') ?? []
  )
}

const STEP_REMINDER_PREFIX = 'Context tools already executed this turn: '

function systemInstructions(callIndex: number) {
  const prompt = mockModel.doGenerateCalls[callIndex]?.prompt ?? []
  const systemMessages = prompt.filter((message) => message.role === 'system')

  // The inference server requires all system messages to precede the conversation.
  expect(prompt.slice(0, systemMessages.length)).toEqual(systemMessages)
  return systemMessages.map((message) => message.content).join('\n')
}

function stepReminderLines(callIndex: number) {
  return systemInstructions(callIndex)
    .split('\n')
    .filter((line) => line.startsWith(STEP_REMINDER_PREFIX))
}

function publicContent() {
  return { about: { description: 'Public career summary.' }, career: [], projects: [] }
}

describe('AMA agent retrieval loop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('retains current-turn results but refuses to execute a hallucinated repeated retrieval', async () => {
    setModelResponses([
      createToolCall('personal-1', 'search_personal_context', { query: 'Quartz Ledger' }),
      createToolCall('personal-2', 'search_personal_context', { query: 'Quartz Ledger' }),
      createAnswer(
        'I keep drafts in a local queue; these notes do not specify the crash algorithm.',
      ),
    ])
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const modelConfig: AmaModelConfig = { model: 'openai/test-model' }
    const getPublicSiteContent = vi.fn(async () => {
      throw new Error('public context unavailable')
    })
    const searchPersonalContext = vi.fn(async (query: string) => ({
      available: true,
      source: 'blob' as const,
      query,
      matches: [],
      content: 'Drafts survive offline in a local queue.',
    }))
    const agent = createAmaAgent({
      modelConfig,
      getPublicSiteContent,
      searchPersonalContext,
    })

    const result = await agent.generate({ prompt: 'Tell me about Quartz Ledger.' })

    expect(result.text).toContain('local queue')
    expect(result.steps).toHaveLength(3)
    expect(mockModel.doGenerateCalls).toHaveLength(3)
    expect(searchPersonalContext).toHaveBeenCalledExactlyOnceWith('Quartz Ledger')
    expect(getPublicSiteContent).not.toHaveBeenCalled()
    expect(availableTools(0)).toContain('search_personal_context')
    expect(availableTools(1)).not.toContain('search_personal_context')
    expect(availableTools(2)).not.toContain('search_personal_context')
    expect(availableTools(2)).not.toContain('get_public_site_content')
    expect(toolResults(2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: 'personal-1',
          output: expect.objectContaining({
            type: 'json',
            value: expect.objectContaining({
              content: 'Drafts survive offline in a local queue.',
              sourceKind: 'personal',
              retrievalStatus: 'found',
            }),
          }),
        }),
      ]),
    )
    expect(result.steps[1]?.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: 'personal-2',
        invalid: true,
        error: expect.any(NoSuchToolError),
      }),
    ])
    expect(stepReminderLines(0)).toEqual([])
    expect(stepReminderLines(1)).toEqual([
      `${STEP_REMINDER_PREFIX}search_personal_context. Do not call them again.`,
    ])
    for (const callIndex of [1, 2]) {
      expect(mockModel.doGenerateCalls[callIndex]?.toolChoice).toEqual({ type: 'none' })
      expect(availableTools(callIndex)).toEqual([])
      expect(stepReminderLines(callIndex)).toEqual([
        `${STEP_REMINDER_PREFIX}search_personal_context. Do not call them again.`,
      ])
      expect(systemInstructions(callIndex)).toContain(
        'Source personal: found. Further calls allowed: no.',
      )
    }
    expect(toolResults(2)).toEqual(expect.arrayContaining(toolResults(1)))
  })

  it('offers resume retrieval only after the public source has been checked', async () => {
    setModelResponses([
      createToolCall('public-1', 'get_public_site_content'),
      createToolCall('resume-1', 'get_resume'),
      createAnswer('I studied computer science.'),
    ])
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const getPublicSiteContent = vi.fn(async () => publicContent())
    const getResumeContext = vi.fn(async () => ({
      available: true,
      source: 'blob' as const,
      content: 'Education details from the resume.',
    }))
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      getPublicSiteContent,
      getResumeContext,
    })

    await agent.generate({ prompt: 'Where did you study?' })

    expect(availableTools(0)).toContain('get_public_site_content')
    expect(availableTools(0)).not.toContain('get_resume')
    expect(availableTools(1)).toContain('get_resume')
    expect(availableTools(1)).not.toContain('get_public_site_content')
    expect(availableTools(2)).not.toContain('get_resume')
    expect(getPublicSiteContent).toHaveBeenCalledTimes(1)
    expect(getResumeContext).toHaveBeenCalledTimes(1)
    expect(getPublicSiteContent.mock.invocationCallOrder[0]).toBeLessThan(
      getResumeContext.mock.invocationCallOrder[0]!,
    )
    expect(toolResults(2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolCallId: 'public-1' }),
        expect.objectContaining({
          toolCallId: 'resume-1',
          output: expect.objectContaining({
            value: expect.objectContaining({ content: 'Education details from the resume.' }),
          }),
        }),
      ]),
    )
    expect(stepReminderLines(0)).toEqual([])
    expect(stepReminderLines(1)).toEqual([
      `${STEP_REMINDER_PREFIX}get_public_site_content. Do not call them again.`,
    ])
    expect(systemInstructions(1)).toContain(
      'Before saying a career, education, or background fact is unknown or absent, call get_resume',
    )
    expect(stepReminderLines(2)).toEqual([
      `${STEP_REMINDER_PREFIX}get_public_site_content, get_resume. Do not call them again.`,
    ])
    expect(systemInstructions(2)).not.toContain(
      'Before saying a career, education, or background fact is unknown or absent, call get_resume',
    )
  })

  it('coalesces same-step duplicate reads without hiding attempts and resets on a new turn', async () => {
    const duplicate = createToolCall('personal-first', 'search_personal_context', {
      query: 'Quartz Ledger',
    })
    duplicate.content.push(
      ...createToolCall('personal-repeat', 'search_personal_context', { query: 'another query' })
        .content,
    )
    setModelResponses([
      duplicate,
      createAnswer('I use a local queue.'),
      duplicate,
      createAnswer('I use a local queue.'),
    ])
    const searchPersonalContext = vi.fn(async (query: string) => ({
      available: true,
      source: 'blob' as const,
      query,
      matches: [],
      content: 'PRIVATE_QUEUE_FACT',
    }))
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      searchPersonalContext,
    })
    for (let turn = 0; turn < 2; turn += 1) {
      const result = await agent.generate({ prompt: 'How did you build your side project?' })
      expect(result.steps[0]!.toolCalls).toHaveLength(2)
      expect(result.steps[0]!.toolResults.map((result) => result.output)).toEqual([
        expect.objectContaining({
          executionStatus: 'executed',
          retrievalStatus: 'found',
          content: 'PRIVATE_QUEUE_FACT',
        }),
        expect.objectContaining({
          executionStatus: 'reused',
          retrievalStatus: 'found',
          content: 'PRIVATE_QUEUE_FACT',
        }),
      ])
      expect(mockModel.doGenerateCalls[turn * 2 + 1]?.toolChoice).toEqual({ type: 'none' })
    }
    expect(searchPersonalContext.mock.calls).toEqual([['Quartz Ledger'], ['Quartz Ledger']])
  })

  it('plans using the actual user messages supplied by a custom step callback', async () => {
    setModelResponses([
      createToolCall('public', 'get_public_site_content'),
      createToolCall('resume', 'get_resume'),
      createAnswer('I studied computing.'),
    ])
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      getPublicSiteContent: async () => publicContent(),
      getResumeContext: async () => ({
        available: true,
        source: 'blob',
        content: 'I studied computing.',
      }),
      prepareStep: ({ messages }) => ({
        messages: messages.map((message) =>
          message.role === 'user' ? { role: 'user', content: 'Where did you study?' } : message,
        ),
      }),
    })
    await agent.generate({ prompt: 'How did you build your side project?' })
    expect(mockModel.doGenerateCalls[0]?.toolChoice).toEqual({ type: 'required' })
    expect(availableTools(0)).toEqual(['get_public_site_content'])
    expect(mockModel.doGenerateCalls[1]?.toolChoice).toEqual({ type: 'required' })
    expect(availableTools(1)).toEqual(['get_resume'])
  })

  it('keeps resume pending after coalescing duplicate public calls in the same step', async () => {
    const duplicate = createToolCall('public-first', 'get_public_site_content')
    duplicate.content.push(...createToolCall('public-repeat', 'get_public_site_content').content)
    setModelResponses([
      duplicate,
      createToolCall('resume', 'get_resume'),
      createAnswer('I studied computing.'),
    ])
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const getPublicSiteContent = vi.fn(async () => publicContent())
    const getResumeContext = vi.fn(async () => ({
      available: true,
      source: 'blob' as const,
      content: 'I studied computing.',
    }))
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      getPublicSiteContent,
      getResumeContext,
    })
    const result = await agent.generate({ prompt: 'Where did you study?' })
    expect(getPublicSiteContent).toHaveBeenCalledTimes(1)
    expect(getResumeContext).toHaveBeenCalledTimes(1)
    expect(result.steps[0]!.toolCalls).toHaveLength(2)
    expect(mockModel.doGenerateCalls[1]?.toolChoice).toEqual({ type: 'required' })
    expect(availableTools(1)).toEqual(['get_resume'])
  })

  it('does not repeat a failed loader when the same step requests it twice', async () => {
    const duplicate = createToolCall('personal-first', 'search_personal_context', {
      query: 'Quartz Ledger',
    })
    duplicate.content.push(
      ...createToolCall('personal-repeat', 'search_personal_context', { query: 'another query' })
        .content,
    )
    setModelResponses([duplicate, createAnswer('I cannot retrieve those notes right now.')])
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const searchPersonalContext = vi.fn(async () => {
      throw new Error('PRIVATE_FAILURE')
    })
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      searchPersonalContext,
    })
    const result = await agent.generate({ prompt: 'How did you build your side project?' })
    expect(searchPersonalContext).toHaveBeenCalledTimes(1)
    expect(result.steps[0]!.toolCalls).toHaveLength(2)
    expect(result.steps[0]!.toolResults).toEqual([
      expect.objectContaining({
        toolCallId: 'personal-repeat',
        output: expect.objectContaining({
          executionStatus: 'reused',
          sourceKind: 'personal',
          retrievalStatus: 'unavailable',
        }),
      }),
    ])
    expect(systemInstructions(1)).toContain('Source personal: unavailable')
    expect(systemInstructions(1)).not.toContain('PRIVATE_FAILURE')
    expect(mockModel.doGenerateCalls[1]?.toolChoice).toEqual({ type: 'none' })
  })

  it('respects a custom no-tools restriction even when the source plan requires retrieval', async () => {
    setModelResponses([createAnswer('I cannot retrieve those details in this request.')])
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      prepareStep: () => ({ toolChoice: 'none' }),
    })
    await agent.generate({ prompt: 'Where did you study?' })
    expect(availableTools(0)).toEqual([])
    expect(mockModel.doGenerateCalls[0]?.toolChoice).toEqual({ type: 'none' })
    expect(systemInstructions(0)).toContain('Required source still pending: public_site')
  })

  it('refuses to execute a hallucinated resume call before public retrieval', async () => {
    setModelResponses([
      createToolCall('premature-resume', 'get_resume'),
      createAnswer('Please check my Career page for my background.'),
    ])
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const getPublicSiteContent = vi.fn(async () => publicContent())
    const getResumeContext = vi.fn(async () => ({
      available: true,
      source: 'blob' as const,
      content: 'This context must not be loaded out of order.',
    }))
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      getPublicSiteContent,
      getResumeContext,
    })

    const result = await agent.generate({ prompt: 'Tell me about your background.' })

    expect(availableTools(0)).not.toContain('get_resume')
    expect(getResumeContext).not.toHaveBeenCalled()
    expect(getPublicSiteContent).not.toHaveBeenCalled()
    expect(result.steps[0]?.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: 'premature-resume',
        invalid: true,
        error: expect.any(NoSuchToolError),
      }),
    ])
    expect(JSON.stringify(toolResults(1))).not.toContain('This context must not be loaded')
    expect(stepReminderLines(1)).toEqual([])
    expect(availableTools(1)).not.toContain('get_resume')
  })

  it('recovers from premature resume retrieval without consuming eligibility or forcing an early final answer', async () => {
    setModelResponses([
      createToolCall('premature-resume', 'get_resume'),
      createToolCall('public-1', 'get_public_site_content'),
      createToolCall('resume-1', 'get_resume'),
      createAnswer('I studied computer science.'),
    ])
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const getPublicSiteContent = vi.fn(async () => publicContent())
    const getResumeContext = vi.fn(async () => ({
      available: true,
      source: 'blob' as const,
      content: 'My degree is in computer science.',
    }))
    const onFinish = vi.fn<NonNullable<CreateAmaAgentOptions['onFinish']>>()
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      getPublicSiteContent,
      getResumeContext,
      onFinish,
    })

    const result = await agent.generate({ prompt: 'Where did you study?' })

    expect(getPublicSiteContent).toHaveBeenCalledTimes(1)
    expect(getResumeContext).toHaveBeenCalledTimes(1)
    expect(getPublicSiteContent.mock.invocationCallOrder[0]).toBeLessThan(
      getResumeContext.mock.invocationCallOrder[0]!,
    )
    expect(stepReminderLines(1)).toEqual([])
    expect(availableTools(1)).not.toContain('get_resume')
    expect(availableTools(2)).toContain('get_resume')
    expect(stepReminderLines(2)).toEqual([
      `${STEP_REMINDER_PREFIX}get_public_site_content. Do not call them again.`,
    ])
    expect(availableTools(3)).not.toContain('get_resume')
    expect(availableTools(3)).toEqual([])
    expect(mockModel.doGenerateCalls[3]?.toolChoice).toEqual({ type: 'none' })
    expect(toolResults(3)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolCallId: 'premature-resume' }),
        expect.objectContaining({ toolCallId: 'public-1' }),
        expect.objectContaining({
          toolCallId: 'resume-1',
          output: expect.objectContaining({
            value: expect.objectContaining({ content: 'My degree is in computer science.' }),
          }),
        }),
      ]),
    )
    // Invalid attempts remain in the full server completion used by traces and scorers.
    const expectedAttempts = ['premature-resume', 'public-1', 'resume-1']
    expect(result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolCallId))).toEqual(
      expectedAttempts,
    )
    expect(
      onFinish.mock.calls[0]?.[0].steps.flatMap((step) =>
        step.toolCalls.map((call) => call.toolCallId),
      ),
    ).toEqual(expectedAttempts)
    expect(result.steps[0]?.toolCalls[0]).toMatchObject({
      invalid: true,
      error: expect.any(NoSuchToolError),
    })
  })

  it('allows resume recovery after rejecting a same-step resume attempt alongside public retrieval', async () => {
    const simultaneousCalls = createToolCall('public-1', 'get_public_site_content')
    simultaneousCalls.content.push(...createToolCall('premature-resume', 'get_resume').content)
    setModelResponses([
      simultaneousCalls,
      createToolCall('resume-1', 'get_resume'),
      createAnswer('I studied computer science.'),
    ])
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const getPublicSiteContent = vi.fn(async () => publicContent())
    const getResumeContext = vi.fn(async () => ({
      available: true,
      source: 'blob' as const,
      content: 'My degree is in computer science.',
    }))
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      getPublicSiteContent,
      getResumeContext,
    })

    const result = await agent.generate({ prompt: 'Where did you study?' })

    expect(result.steps[0]?.toolCalls).toEqual([
      expect.objectContaining({ toolCallId: 'public-1', toolName: 'get_public_site_content' }),
      expect.objectContaining({
        toolCallId: 'premature-resume',
        invalid: true,
        error: expect.any(NoSuchToolError),
      }),
    ])
    expect(getPublicSiteContent).toHaveBeenCalledTimes(1)
    expect(getResumeContext).toHaveBeenCalledTimes(1)
    expect(availableTools(1)).toContain('get_resume')
    expect(stepReminderLines(1)).toEqual([
      `${STEP_REMINDER_PREFIX}get_public_site_content. Do not call them again.`,
    ])
    expect(toolResults(1).some((part) => part.toolCallId === 'resume-1')).toBe(false)
    expect(availableTools(2)).not.toContain('get_resume')
    expect(mockModel.doGenerateCalls[2]?.toolChoice).toEqual({ type: 'none' })
    expect(stepReminderLines(2)).toEqual([
      `${STEP_REMINDER_PREFIX}get_public_site_content, get_resume. Do not call them again.`,
    ])
    expect(toolResults(2).map((part) => part.toolCallId)).toEqual(
      expect.arrayContaining(['premature-resume', 'public-1', 'resume-1']),
    )
  })

  it('does not unlock resume or consume public retrieval when public arguments are invalid', async () => {
    setModelResponses([
      createToolCall('invalid-public', 'get_public_site_content', 'not-an-object'),
      createToolCall('public-1', 'get_public_site_content'),
      createToolCall('resume-1', 'get_resume'),
      createAnswer('I studied computer science.'),
    ])
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const getPublicSiteContent = vi.fn(async () => publicContent())
    const getResumeContext = vi.fn(async () => ({
      available: true,
      source: 'blob' as const,
      content: 'My degree is in computer science.',
    }))
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      getPublicSiteContent,
      getResumeContext,
    })

    const result = await agent.generate({ prompt: 'Where did you study?' })

    expect(result.steps[0]?.toolCalls[0]).toMatchObject({
      toolCallId: 'invalid-public',
      invalid: true,
      error: expect.any(InvalidToolInputError),
    })
    expect(stepReminderLines(1)).toEqual([])
    expect(availableTools(1)).toContain('get_public_site_content')
    expect(availableTools(1)).not.toContain('get_resume')
    expect(availableTools(2)).not.toContain('get_public_site_content')
    expect(availableTools(2)).toContain('get_resume')
    expect(getPublicSiteContent).toHaveBeenCalledTimes(1)
    expect(getResumeContext).toHaveBeenCalledTimes(1)
    expect(result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolCallId))).toEqual([
      'invalid-public',
      'public-1',
      'resume-1',
    ])
  })

  it('allows a corrected search after invalid arguments and executes that source only once', async () => {
    setModelResponses([
      createToolCall('invalid-personal', 'search_personal_context', { query: '' }),
      createToolCall('personal-1', 'search_personal_context', { query: 'Quartz Ledger' }),
      createToolCall('repeated-personal', 'search_personal_context', { query: 'local storage' }),
      createAnswer('I built a local notebook.'),
    ])
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const searchPersonalContext = vi.fn(async (query: string) => ({
      available: true,
      source: 'blob' as const,
      query,
      matches: [],
      content: 'I built a local notebook.',
    }))
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      searchPersonalContext,
    })

    const result = await agent.generate({ prompt: 'How did you build Quartz Ledger?' })

    expect(result.steps[0]?.toolCalls[0]).toMatchObject({
      invalid: true,
      error: expect.any(InvalidToolInputError),
    })
    expect(stepReminderLines(1)).toEqual([])
    expect(availableTools(1)).toContain('search_personal_context')
    expect(searchPersonalContext).toHaveBeenCalledExactlyOnceWith('Quartz Ledger')
    expect(availableTools(2)).not.toContain('search_personal_context')
    expect(result.steps[2]?.toolCalls[0]).toMatchObject({
      invalid: true,
      error: expect.any(NoSuchToolError),
    })
    for (const callIndex of [2, 3]) {
      expect(stepReminderLines(callIndex)).toEqual([
        `${STEP_REMINDER_PREFIX}search_personal_context. Do not call them again.`,
      ])
    }
    expect(toolResults(3)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: 'personal-1',
          output: expect.objectContaining({
            value: expect.objectContaining({ content: 'I built a local notebook.' }),
          }),
        }),
      ]),
    )
  })

  it('keeps the four-step ceiling when every attempted call is rejected', async () => {
    setModelResponses([
      ...Array.from({ length: 4 }, (_, index) =>
        createToolCall(`invalid-public-${index}`, 'get_public_site_content', 'not-an-object'),
      ),
      createAnswer('Please check my Career page for my background.'),
    ])
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const getPublicSiteContent = vi.fn(async () => publicContent())
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      getPublicSiteContent,
    })

    const result = await agent.generate({ prompt: 'Tell me about your background.' })

    expect(getPublicSiteContent).not.toHaveBeenCalled()
    expect(mockModel.doGenerateCalls).toHaveLength(5)
    for (const callIndex of [0, 1, 2, 3]) {
      expect(availableTools(callIndex)).toContain('get_public_site_content')
      expect(availableTools(callIndex)).not.toContain('get_resume')
      expect(stepReminderLines(callIndex)).toEqual([])
    }
    expect(availableTools(4)).toEqual([])
    expect(mockModel.doGenerateCalls[4]?.toolChoice).toEqual({ type: 'none' })
    expect(stepReminderLines(4)).toEqual([])
    expect(result.steps.flatMap((step) => step.toolCalls)).toHaveLength(4)
  })

  it.each(['invalid arguments', 'repeated retrieval'] as const)(
    'stops after five SDK steps when the model keeps emitting %s despite no tools',
    async (behavior) => {
      let generatedCalls = 0
      mockModel = new MockLanguageModelV3({
        // Intentionally never produce a text answer: the application ceiling
        // must stop the SDK even when the provider ignores toolChoice:none.
        doGenerate: async () => {
          const callId = `attempt-${generatedCalls++}`
          return behavior === 'invalid arguments'
            ? createToolCall(callId, 'get_public_site_content', 'not-an-object')
            : createToolCall(callId, 'search_personal_context', { query: 'Quartz Ledger' })
        },
      })
      const { createAmaAgent } = await import('@/lib/ama-agent')
      const getPublicSiteContent = vi.fn(async () => publicContent())
      const searchPersonalContext = vi.fn(async (query: string) => ({
        available: true,
        source: 'blob' as const,
        query,
        matches: [],
        content: 'PRIVATE_RETAINED_QUEUE_FACT',
      }))
      const onFinish = vi.fn<NonNullable<CreateAmaAgentOptions['onFinish']>>()
      const agent = createAmaAgent({
        modelConfig: { model: 'openai/test-model' },
        getPublicSiteContent,
        searchPersonalContext,
        onFinish,
      })

      const result = await agent.generate({ prompt: 'Tell me about Quartz Ledger.' })

      expect(generatedCalls).toBe(5)
      expect(mockModel.doGenerateCalls).toHaveLength(5)
      expect(result.steps).toHaveLength(5)
      expect(result.text).toBe('')
      expect(result.finishReason).toBe('tool-calls')
      expect(getPublicSiteContent).not.toHaveBeenCalled()
      expect(searchPersonalContext).toHaveBeenCalledTimes(behavior === 'repeated retrieval' ? 1 : 0)
      const expectedAttempts = Array.from({ length: 5 }, (_, index) => `attempt-${index}`)
      expect(result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolCallId))).toEqual(
        expectedAttempts,
      )
      expect(onFinish).toHaveBeenCalledTimes(1)
      expect(
        onFinish.mock.calls[0]?.[0].steps.flatMap((step) =>
          step.toolCalls.map((call) => call.toolCallId),
        ),
      ).toEqual(expectedAttempts)
      expect(JSON.stringify(onFinish.mock.calls[0]?.[0].response.messages)).toContain('attempt-4')
      for (const index of behavior === 'repeated retrieval' ? [1, 2, 3, 4] : [4]) {
        expect(availableTools(index)).toEqual([])
        expect(mockModel.doGenerateCalls[index]?.toolChoice).toEqual({ type: 'none' })
        expect(result.steps[index]?.toolCalls[0]).toMatchObject({
          invalid: true,
          error: expect.any(NoSuchToolError),
        })
      }
      if (behavior === 'invalid arguments') {
        expect(result.steps.slice(0, 4).every((step) => step.toolCalls[0]?.invalid)).toBe(true)
      } else {
        expect(toolResults(4)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              toolCallId: 'attempt-0',
              output: expect.objectContaining({
                value: expect.objectContaining({ content: 'PRIVATE_RETAINED_QUEUE_FACT' }),
              }),
            }),
          ]),
        )
      }
    },
  )

  it.each([
    { label: 'a custom twenty-step limit', stopWhen: stepCountIs(20), expectedSteps: 5 },
    { label: 'an earlier custom limit', stopWhen: stepCountIs(2), expectedSteps: 2 },
    {
      label: 'an earlier condition in a custom array',
      stopWhen: [stepCountIs(20), stepCountIs(2)],
      expectedSteps: 2,
    },
  ])('preserves the application ceiling and $label', async ({ stopWhen, expectedSteps }) => {
    let generatedCalls = 0
    mockModel = new MockLanguageModelV3({
      doGenerate: async () =>
        createToolCall(`invalid-${generatedCalls++}`, 'get_public_site_content', 'not-an-object'),
    })
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const getPublicSiteContent = vi.fn(async () => publicContent())
    const prepareCall = vi.fn<NonNullable<CreateAmaAgentOptions['prepareCall']>>(
      async (callOptions) => ({ ...callOptions, stopWhen }),
    )
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      getPublicSiteContent,
      prepareCall,
    })

    const result = await agent.generate({ prompt: 'Tell me about your background.' })

    expect(prepareCall).toHaveBeenCalledTimes(1)
    expect(generatedCalls).toBe(expectedSteps)
    expect(result.steps).toHaveLength(expectedSteps)
    expect(result.steps.flatMap((step) => step.toolCalls)).toHaveLength(expectedSteps)
    expect(getPublicSiteContent).not.toHaveBeenCalled()
    expect(result.text).toBe('')
    expect(result.finishReason).toBe('tool-calls')
  })

  it('allows the same agent to retrieve again on the next user turn', async () => {
    setModelResponses([
      createToolCall('public-1', 'get_public_site_content'),
      createToolCall('resume-1', 'get_resume'),
      createAnswer('I studied computer science.'),
      createToolCall('public-2', 'get_public_site_content'),
      createToolCall('resume-2', 'get_resume'),
      createAnswer('My graduate work focused on reliable interfaces.'),
    ])
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const getPublicSiteContent = vi.fn(async () => publicContent())
    const getResumeContext = vi.fn(async () => ({
      available: true,
      source: 'blob' as const,
      content: 'My education and graduate research details.',
    }))
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      getPublicSiteContent,
      getResumeContext,
    })
    const firstQuestion = 'Where did you study?'
    const first = await agent.generate({ prompt: firstQuestion })
    const second = await agent.generate({
      messages: [
        { role: 'user', content: firstQuestion },
        ...first.response.messages,
        { role: 'user', content: 'What did you focus on in graduate school?' },
      ],
    })

    expect(second.text).toContain('graduate work')
    expect(getPublicSiteContent).toHaveBeenCalledTimes(2)
    expect(getResumeContext).toHaveBeenCalledTimes(2)
    expect(availableTools(3)).toContain('get_public_site_content')
    expect(availableTools(3)).not.toContain('get_resume')
    expect(availableTools(4)).toContain('get_resume')
    expect(toolResults(3)).toEqual([])
    expect(toolResults(5).map((part) => part.toolCallId)).toEqual(['public-2', 'resume-2'])
    expect(JSON.stringify(mockModel.doGenerateCalls[3]?.prompt)).toContain(first.text)
    expect(JSON.stringify(first.response.messages)).not.toContain(STEP_REMINDER_PREFIX)
    expect(stepReminderLines(3)).toEqual([])
    expect(stepReminderLines(4)).toEqual([
      `${STEP_REMINDER_PREFIX}get_public_site_content. Do not call them again.`,
    ])
    expect(stepReminderLines(5)).toEqual([
      `${STEP_REMINDER_PREFIX}get_public_site_content, get_resume. Do not call them again.`,
    ])
  })

  it('lets custom prepareStep narrow tools without re-enabling tools already used', async () => {
    setModelResponses([
      createToolCall('personal-1', 'search_personal_context', { query: 'Quartz Ledger' }),
      createAnswer('I built a local notebook.'),
    ])
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const prepareStep = vi.fn<NonNullable<CreateAmaAgentOptions['prepareStep']>>(
      ({ stepNumber }) => ({
        activeTools:
          stepNumber === 0
            ? ['search_personal_context']
            : ['search_personal_context', 'get_public_site_content'],
      }),
    )
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      prepareStep,
      searchPersonalContext: async (query) => ({
        available: true,
        source: 'blob',
        query,
        matches: [],
        content: 'I built a local notebook.',
      }),
    })

    await agent.generate({ prompt: 'How did you build Quartz Ledger?' })

    expect(prepareStep).toHaveBeenCalledTimes(2)
    expect(availableTools(0)).toEqual(['search_personal_context'])
    expect(availableTools(1)).toEqual([])
    expect(systemInstructions(1)).toContain(
      'No more tools are available. Answer using the existing results',
    )
  })

  it('preserves separate work and personal results through legitimate sequential retrieval', async () => {
    setModelResponses([
      createToolCall('work-1', 'search_work_context', { query: 'reliable systems' }),
      createToolCall('personal-1', 'search_personal_context', { query: 'Quartz Ledger' }),
      createAnswer('My work and side project both use explicit recovery paths.'),
    ])
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const searchWorkContext = vi.fn(async (query: string) => ({
      available: true,
      source: 'blob' as const,
      query,
      matches: [],
      content: 'At work I designed explicit recovery paths for an internal system.',
    }))
    const searchPersonalContext = vi.fn(async (query: string) => ({
      available: true,
      source: 'blob' as const,
      query,
      matches: [],
      content: 'Quartz Ledger keeps local drafts recoverable after an interrupted sync.',
    }))
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      getPublicSiteContent: async () => publicContent(),
      searchWorkContext,
      searchPersonalContext,
    })

    await agent.generate({
      prompt: 'Compare recovery in your work and Quartz Ledger side project.',
    })

    expect(searchWorkContext).toHaveBeenCalledExactlyOnceWith('reliable systems')
    expect(searchPersonalContext).toHaveBeenCalledExactlyOnceWith('Quartz Ledger')
    expect(availableTools(1)).toContain('search_personal_context')
    expect(availableTools(1)).not.toContain('search_work_context')
    expect(availableTools(2)).toEqual([])
    expect(stepReminderLines(1)).toEqual([
      `${STEP_REMINDER_PREFIX}search_work_context. Do not call them again.`,
    ])
    expect(stepReminderLines(2)).toEqual([
      `${STEP_REMINDER_PREFIX}search_work_context, search_personal_context. Do not call them again.`,
    ])
    expect(mockModel.doGenerateCalls[2]?.toolChoice).toEqual({ type: 'none' })
    expect(toolResults(2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: 'work-1',
          output: expect.objectContaining({
            value: expect.objectContaining({
              content: 'At work I designed explicit recovery paths for an internal system.',
            }),
          }),
        }),
        expect.objectContaining({
          toolCallId: 'personal-1',
          output: expect.objectContaining({
            value: expect.objectContaining({
              content: 'Quartz Ledger keeps local drafts recoverable after an interrupted sync.',
            }),
          }),
        }),
      ]),
    )
  })

  it('does not promote unknown model-generated tool names into the system reminder', async () => {
    const unknownToolName = 'untrusted_tool_name'
    setModelResponses([
      createToolCall('unknown-1', unknownToolName),
      createToolCall('public-1', 'get_public_site_content'),
      createAnswer('Here is my public career summary.'),
    ])
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const getPublicSiteContent = vi.fn(async () => publicContent())
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      getPublicSiteContent,
    })

    const result = await agent.generate({ prompt: 'What have you worked on?' })

    expect(result.steps[0]?.toolCalls).toEqual([
      expect.objectContaining({ invalid: true, error: expect.any(NoSuchToolError) }),
    ])
    expect(getPublicSiteContent).toHaveBeenCalledTimes(1)
    expect(stepReminderLines(1)).toEqual([])
    expect(stepReminderLines(2)).toEqual([
      `${STEP_REMINDER_PREFIX}get_public_site_content. Do not call them again.`,
    ])
    for (const callIndex of [0, 1, 2]) {
      expect(systemInstructions(callIndex)).not.toContain(unknownToolName)
    }
    expect(JSON.stringify(mockModel.doGenerateCalls[2]?.prompt)).toContain(unknownToolName)
  })

  const customInstructionCases: Array<{
    label: string
    instructions: AmaAgentSettings['instructions']
  }> = [
    { label: 'string', instructions: 'Custom request instructions.' },
    {
      label: 'system message',
      instructions: {
        role: 'system',
        content: 'Custom request instructions.',
        providerOptions: { test: { marker: 'preserved' } },
      },
    },
    {
      label: 'system message array',
      instructions: [
        { role: 'system', content: 'Additional custom instruction.' },
        {
          role: 'system',
          content: 'Custom request instructions.',
          providerOptions: { test: { marker: 'preserved' } },
        },
      ],
    },
  ]

  it.each(customInstructionCases)(
    'preserves custom prepareCall instructions as a $label without accumulating reminders',
    async ({ instructions }) => {
      setModelResponses([
        createToolCall('public-1', 'get_public_site_content'),
        createToolCall('resume-1', 'get_resume'),
        createAnswer('I studied computer science.'),
      ])
      const { createAmaAgent } = await import('@/lib/ama-agent')
      const agent = createAmaAgent({
        modelConfig: { model: 'openai/test-model' },
        prepareCall: async (callOptions) => ({ ...callOptions, instructions }),
        getPublicSiteContent: async () => publicContent(),
        getResumeContext: async () => ({
          available: true,
          source: 'blob',
          content: 'My education details.',
        }),
      })

      await agent.generate({ prompt: 'Where did you study?' })

      for (const callIndex of [0, 1, 2]) {
        expect(systemInstructions(callIndex)).toContain('Custom request instructions.')
        expect(systemInstructions(callIndex).match(/Custom request instructions\./g)).toHaveLength(
          1,
        )
        if (typeof instructions !== 'string') {
          const messages = mockModel.doGenerateCalls[callIndex]?.prompt.filter(
            (message) => message.role === 'system',
          )
          expect(messages?.at(-1)?.providerOptions).toEqual({ test: { marker: 'preserved' } })
        }
        if (Array.isArray(instructions)) {
          expect(systemInstructions(callIndex)).toContain('Additional custom instruction.')
        }
      }
      expect(stepReminderLines(0)).toEqual([])
      expect(stepReminderLines(1)).toEqual([
        `${STEP_REMINDER_PREFIX}get_public_site_content. Do not call them again.`,
      ])
      expect(stepReminderLines(2)).toEqual([
        `${STEP_REMINDER_PREFIX}get_public_site_content, get_resume. Do not call them again.`,
      ])
    },
  )

  it('keeps custom instructions isolated between concurrent calls on the same agent', async () => {
    let releaseCalls!: () => void
    const bothCallsPrepared = new Promise<void>((resolve) => {
      releaseCalls = resolve
    })
    let preparedCalls = 0
    mockModel = new MockLanguageModelV3({
      doGenerate: async ({ prompt }) => {
        const userMessage = prompt.find((message) => message.role === 'user')
        const request = JSON.stringify(userMessage).includes('request-alpha') ? 'alpha' : 'beta'
        return prompt.some((message) => message.role === 'tool')
          ? createAnswer(`Public summary for ${request}.`)
          : createToolCall(`public-${request}`, 'get_public_site_content')
      },
    })
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const agent = createAmaAgent({
      modelConfig: { model: 'openai/test-model' },
      prepareCall: async (callOptions) => {
        preparedCalls += 1
        if (preparedCalls === 2) {
          releaseCalls()
        }
        await bothCallsPrepared
        return {
          ...callOptions,
          instructions:
            callOptions.prompt === 'request-alpha'
              ? 'Instructions only for alpha.'
              : 'Instructions only for beta.',
        }
      },
      getPublicSiteContent: async () => publicContent(),
    })

    const results = await Promise.all([
      agent.generate({ prompt: 'request-alpha' }),
      agent.generate({ prompt: 'request-beta' }),
    ])

    expect(results.map((result) => result.text)).toEqual([
      'Public summary for alpha.',
      'Public summary for beta.',
    ])
    expect(mockModel.doGenerateCalls).toHaveLength(4)
    for (const [callIndex, call] of mockModel.doGenerateCalls.entries()) {
      const userMessage = call.prompt.find((message) => message.role === 'user')
      const isAlpha = JSON.stringify(userMessage).includes('request-alpha')
      expect(systemInstructions(callIndex)).toContain(
        `Instructions only for ${isAlpha ? 'alpha' : 'beta'}.`,
      )
      expect(systemInstructions(callIndex)).not.toContain(
        `Instructions only for ${isAlpha ? 'beta' : 'alpha'}.`,
      )
      expect(stepReminderLines(callIndex)).toHaveLength(toolResults(callIndex).length > 0 ? 1 : 0)
    }
  })
})
