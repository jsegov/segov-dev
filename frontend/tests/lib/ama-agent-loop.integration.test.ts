import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvalidToolInputError, NoSuchToolError } from 'ai'
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
  input: Record<string, unknown> = {},
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
      createToolCall('public-1', 'get_public_site_content'),
      createToolCall('personal-2', 'search_personal_context', { query: 'Quartz Ledger' }),
      createAnswer('I do not have reliable context for that project. Try my Projects page.'),
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
      content: 'No matching personal context was found.',
    }))
    const agent = createAmaAgent({
      modelConfig,
      getPublicSiteContent,
      searchPersonalContext,
    })

    const result = await agent.generate({ prompt: 'Tell me about Quartz Ledger.' })

    expect(result.text).toContain('Projects page')
    expect(result.steps).toHaveLength(4)
    expect(mockModel.doGenerateCalls).toHaveLength(4)
    expect(searchPersonalContext).toHaveBeenCalledExactlyOnceWith('Quartz Ledger')
    expect(getPublicSiteContent).toHaveBeenCalledTimes(1)
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
            value: expect.objectContaining({ content: 'No matching personal context was found.' }),
          }),
        }),
        expect.objectContaining({
          toolCallId: 'public-1',
          output: expect.objectContaining({
            type: 'json',
            value: expect.objectContaining({ available: false }),
          }),
        }),
      ]),
    )
    expect(result.steps[2]?.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: 'personal-2',
        invalid: true,
        error: expect.any(NoSuchToolError),
      }),
    ])
    expect(mockModel.doGenerateCalls[3]?.toolChoice).not.toEqual({ type: 'none' })
    expect(availableTools(3)).toEqual(['get_resume', 'search_work_context'])
    expect(stepReminderLines(0)).toEqual([])
    expect(stepReminderLines(1)).toEqual([
      `${STEP_REMINDER_PREFIX}search_personal_context. Do not call them again.`,
    ])
    for (const callIndex of [2, 3]) {
      expect(stepReminderLines(callIndex)).toEqual([
        `${STEP_REMINDER_PREFIX}get_public_site_content, search_personal_context. Do not call them again.`,
      ])
    }
    expect(systemInstructions(3)).toContain('an unavailable result or error is not usable context')
    expect(toolResults(3)).toEqual(expect.arrayContaining(toolResults(2)))
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
    expect(availableTools(3)).toEqual(['search_work_context', 'search_personal_context'])
    expect(mockModel.doGenerateCalls[3]?.toolChoice).not.toEqual({ type: 'none' })
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
    expect(mockModel.doGenerateCalls[2]?.toolChoice).not.toEqual({ type: 'none' })
    expect(stepReminderLines(2)).toEqual([
      `${STEP_REMINDER_PREFIX}get_public_site_content, get_resume. Do not call them again.`,
    ])
    expect(toolResults(2).map((part) => part.toolCallId)).toEqual(
      expect.arrayContaining(['premature-resume', 'public-1', 'resume-1']),
    )
  })

  it('does not unlock resume or consume public retrieval when public arguments are invalid', async () => {
    setModelResponses([
      createToolCall('invalid-public', 'get_public_site_content', { reason: 42 }),
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
        createToolCall(`invalid-public-${index}`, 'get_public_site_content', { reason: 42 }),
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
    expect(availableTools(1)).toEqual(['get_public_site_content'])
    expect(systemInstructions(1)).toContain(
      'Tools still available: get_public_site_content. Use another source only if the question requires it.',
    )
  })

  it('preserves separate work and personal results through legitimate sequential retrieval', async () => {
    setModelResponses([
      createToolCall('work-1', 'search_work_context', { query: 'reliable systems' }),
      createToolCall('personal-1', 'search_personal_context', { query: 'Quartz Ledger' }),
      createToolCall('public-1', 'get_public_site_content'),
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
    expect(availableTools(2)).toEqual(['get_public_site_content'])
    expect(stepReminderLines(1)).toEqual([
      `${STEP_REMINDER_PREFIX}search_work_context. Do not call them again.`,
    ])
    expect(stepReminderLines(2)).toEqual([
      `${STEP_REMINDER_PREFIX}search_work_context, search_personal_context. Do not call them again.`,
    ])
    expect(stepReminderLines(3)).toEqual([
      `${STEP_REMINDER_PREFIX}get_public_site_content, search_work_context, search_personal_context. Do not call them again.`,
    ])
    expect(toolResults(3)).toEqual(
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
