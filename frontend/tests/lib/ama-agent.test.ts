import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from 'ai'
import { DEFAULT_AMA_CHAT_MODEL } from '@/lib/ama-model-config'

const { getPublicSiteContentMock, toolLoopAgentSettings } = vi.hoisted(() => ({
  getPublicSiteContentMock: vi.fn(),
  toolLoopAgentSettings: [] as Array<Record<string, unknown>>,
}))

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()

  class ToolLoopAgent {
    settings: Record<string, unknown>
    tools: Record<string, { execute?: (...args: unknown[]) => Promise<unknown> | unknown }>

    constructor(settings: Record<string, unknown>) {
      this.settings = settings
      this.tools =
        (settings.tools as Record<
          string,
          { execute?: (...args: unknown[]) => Promise<unknown> | unknown }
        >) ?? {}
      toolLoopAgentSettings.push(settings)
    }
  }

  return {
    ...actual,
    tool: (definition: unknown) => definition,
    ToolLoopAgent,
  }
})

vi.mock('@/lib/content', () => ({
  getPublicSiteContent: getPublicSiteContentMock,
}))

describe('createAmaAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toolLoopAgentSettings.length = 0
    getPublicSiteContentMock.mockResolvedValue({
      about: {
        description: 'Public about copy',
      },
      career: [
        {
          title: 'Software Engineer',
          companyName: 'Example Co',
          startDate: '2024-01-01',
          endDate: null,
          description: 'Built public systems.',
          skills: ['TypeScript'],
        },
      ],
      projects: [
        {
          name: 'segov.dev',
          description: 'Public portfolio site',
          skills: ['Next.js'],
          githubUrl: 'https://github.com/jsegov/segov-dev',
          websiteUrl: 'https://segov.dev',
        },
      ],
    })
    delete process.env.AMA_CHAT_MODEL
    delete process.env.AMA_CHAT_PROVIDERS
    delete process.env.AMA_INFERENCE_BASE_URL
    delete process.env.AMA_INFERENCE_REASONING_EFFORT
    delete process.env.AMA_DEPLOYMENT_MODEL
  })

  it('uses the default model and omits provider options when AMA_CHAT_PROVIDERS is unset', async () => {
    const { createAmaAgent } = await import('@/lib/ama-agent')

    createAmaAgent()

    expect(toolLoopAgentSettings).toHaveLength(1)
    expect(toolLoopAgentSettings[0]).toMatchObject({
      model: DEFAULT_AMA_CHAT_MODEL,
    })
    expect(toolLoopAgentSettings[0]?.providerOptions).toBeUndefined()
    expect(toolLoopAgentSettings[0]).not.toHaveProperty('temperature')
    expect(toolLoopAgentSettings[0]).not.toHaveProperty('seed')
  })

  it('registers resume plus work and personal context tools with routing instructions', async () => {
    const { createAmaAgent } = await import('@/lib/ama-agent')

    createAmaAgent()

    const tools = toolLoopAgentSettings[0]?.tools as Record<string, unknown>
    const instructions = toolLoopAgentSettings[0]?.instructions as string

    expect(tools).toHaveProperty('get_public_site_content')
    expect(tools).toHaveProperty('get_resume')
    expect(tools).toHaveProperty('search_work_context')
    expect(tools).toHaveProperty('search_personal_context')
    expect(tools).not.toHaveProperty('search_ama_context')
    expect(instructions).toContain('call get_public_site_content first')
    expect(instructions).toContain('search_work_context')
    expect(instructions).toContain('search_personal_context')
    expect(instructions).toContain('how did you build X')
    expect(instructions).toContain('even if public site content has a short project summary')
    expect(instructions).toContain('Work context disclosure policy')
    expect(instructions).toContain('Never include')
  })

  it('requires first-person answers while preserving the exact refusal and disclosure policy', async () => {
    const { AMA_INSTRUCTIONS, OUT_OF_SCOPE_MESSAGE, createAmaAgent } = await import(
      '@/lib/ama-agent'
    )

    createAmaAgent()

    expect(OUT_OF_SCOPE_MESSAGE).toBe(
      'Error: Query outside permitted scope. This terminal only responds to questions about me, Jonathan Segovia.',
    )
    expect(AMA_INSTRUCTIONS).toContain('Answer as Jonathan in the first person')
    expect(AMA_INSTRUCTIONS).toContain('first-person pronouns such as "I", "me", and "my"')
    expect(AMA_INSTRUCTIONS).toContain('Never describe me as "he", "him", or "his"')
    expect(AMA_INSTRUCTIONS).toContain('Prefer: "I worked on scaling a real-time data pipeline')
    expect(AMA_INSTRUCTIONS).toContain('Avoid: "I built a 3-tier Kafka → Redis pipeline')
    expect(AMA_INSTRUCTIONS).toContain('Customer, account, or partner names, or other identifiers')
    expect(AMA_INSTRUCTIONS).toContain('Service implementation details')
    expect(toolLoopAgentSettings[0]).toMatchObject({
      instructions: AMA_INSTRUCTIONS,
    })
  })

  it('exports a serializable, versioned prompt manifest matching the registered tools', async () => {
    const { AMA_PROMPT_MANIFEST, AMA_SYSTEM_PROMPT_VERSION, createAmaAgent } = await import(
      '@/lib/ama-agent'
    )

    createAmaAgent()

    const tools = toolLoopAgentSettings[0]?.tools as Record<string, unknown>
    expect(AMA_PROMPT_MANIFEST.tools.map((declaration) => declaration.name)).toEqual(
      Object.keys(tools),
    )
    expect(AMA_PROMPT_MANIFEST.callSettings).toEqual({ maxOutputTokens: 512 })
    expect(() => JSON.stringify(AMA_PROMPT_MANIFEST)).not.toThrow()
    expect(AMA_SYSTEM_PROMPT_VERSION).toMatch(/^[a-f0-9]{64}$/)
  })

  it('sets an explicit output budget and prunes completed retrieval calls before each step', async () => {
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const messages = [
      { role: 'user', content: 'How did you build segov.dev?' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'old-context-call',
            toolName: 'search_personal_context',
            input: { query: 'How did you build segov.dev?' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'old-context-call',
            toolName: 'search_personal_context',
            output: {
              type: 'json',
              value: { content: 'Large retrieved context' },
            },
          },
        ],
      },
      { role: 'assistant', content: 'I built it with Next.js.' },
      { role: 'user', content: 'How did you build the fine-tuning flywheel?' },
    ] satisfies ModelMessage[]

    createAmaAgent()

    const prepareStep = toolLoopAgentSettings[0]?.prepareStep as (options: {
      messages: ModelMessage[]
    }) => Promise<{ messages?: ModelMessage[] }>
    const prepared = await prepareStep({ messages })

    expect(toolLoopAgentSettings[0]).toMatchObject({ maxOutputTokens: 512 })
    expect(prepared.messages).toEqual([messages[0], messages[3], messages[4]])
  })

  it('keeps the current retrieval call/result pair for the model step that answers it', async () => {
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const messages = [
      { role: 'user', content: 'How did you build the fine-tuning flywheel?' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'current-context-call',
            toolName: 'search_personal_context',
            input: { query: 'How did you build the fine-tuning flywheel?' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'current-context-call',
            toolName: 'search_personal_context',
            output: {
              type: 'json',
              value: { content: 'Current retrieved context' },
            },
          },
        ],
      },
    ] satisfies ModelMessage[]

    createAmaAgent()

    const prepareStep = toolLoopAgentSettings[0]?.prepareStep as (options: {
      messages: ModelMessage[]
    }) => Promise<{ messages?: ModelMessage[] }>
    const prepared = await prepareStep({ messages })

    expect(prepared.messages).toEqual(messages)
  })

  it('prunes the initial call before trace capture so traces match effective model input', async () => {
    const tracePrepareCall = vi.fn((callOptions: Record<string, unknown>) => callOptions)
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const prompt = [
      { role: 'user', content: 'First question' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'completed-call',
            toolName: 'get_public_site_content',
            input: {},
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'completed-call',
            toolName: 'get_public_site_content',
            output: { type: 'json', value: { content: 'Public context' } },
          },
        ],
      },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Follow-up question' },
    ] satisfies ModelMessage[]

    createAmaAgent({
      prepareCall: tracePrepareCall as never,
    })

    const prepareCall = toolLoopAgentSettings[0]?.prepareCall as (options: {
      prompt: ModelMessage[]
    }) => Promise<{ prompt?: ModelMessage[] }>
    const prepared = await prepareCall({ prompt })
    const expectedPrompt = [prompt[0], prompt[3], prompt[4]]

    expect(tracePrepareCall).toHaveBeenCalledWith({ prompt: expectedPrompt })
    expect(prepared.prompt).toEqual(expectedPrompt)
  })

  it('uses the env-specified model string', async () => {
    process.env.AMA_CHAT_MODEL = 'anthropic/claude-sonnet-4'

    const { createAmaAgent } = await import('@/lib/ama-agent')

    createAmaAgent()

    expect(toolLoopAgentSettings[0]).toMatchObject({
      model: 'anthropic/claude-sonnet-4',
    })
  })

  it('passes gateway provider order and only lists when AMA_CHAT_PROVIDERS is set', async () => {
    process.env.AMA_CHAT_PROVIDERS = 'vertex,anthropic'

    const { createAmaAgent } = await import('@/lib/ama-agent')

    createAmaAgent()

    expect(toolLoopAgentSettings[0]).toMatchObject({
      model: DEFAULT_AMA_CHAT_MODEL,
      providerOptions: {
        gateway: {
          order: ['vertex', 'anthropic'],
          only: ['vertex', 'anthropic'],
        },
      },
    })
  })

  it('resolves an openai-compatible model when the inference endpoint is configured', async () => {
    process.env.AMA_INFERENCE_BASE_URL = 'https://inference.example.com/v1'
    process.env.AMA_DEPLOYMENT_MODEL = 'tinker://run-id:train:0/sampler_weights/final'
    process.env.AMA_INFERENCE_REASONING_EFFORT = 'high'

    const { createAmaAgent } = await import('@/lib/ama-agent')

    createAmaAgent()

    expect(toolLoopAgentSettings[0]?.model).not.toBeTypeOf('string')
    expect(toolLoopAgentSettings[0]?.model).toMatchObject({
      modelId: 'tinker://run-id:train:0/sampler_weights/final',
    })
    expect(toolLoopAgentSettings[0]?.providerOptions).toEqual({
      inference: { reasoning_effort: 'high' },
    })
    expect(toolLoopAgentSettings[0]).toMatchObject({
      maxOutputTokens: 512,
      temperature: 0,
      seed: 1,
    })
  })

  it('returns public site content from the public site content tool', async () => {
    const { createAmaAgent } = await import('@/lib/ama-agent')

    const agent = createAmaAgent() as {
      tools: Record<string, { execute?: (...args: unknown[]) => Promise<unknown> | unknown }>
    }

    const result = await agent.tools.get_public_site_content.execute?.({})

    expect(result).toMatchObject({
      available: true,
      source: 'edge_config',
      content: expect.stringContaining('Public about copy'),
    })
    expect(result).toMatchObject({
      content: expect.stringContaining('segov.dev'),
    })
  })

  it('returns deterministic unavailable output when public site content fails', async () => {
    getPublicSiteContentMock.mockRejectedValueOnce(new Error('edge config unavailable'))
    const { createAmaAgent } = await import('@/lib/ama-agent')

    const agent = createAmaAgent() as {
      tools: Record<string, { execute?: (...args: unknown[]) => Promise<unknown> | unknown }>
    }

    const result = await agent.tools.get_public_site_content.execute?.({})

    expect(result).toMatchObject({
      available: false,
      source: 'edge_config_unavailable',
      content: expect.stringContaining('Public site content is unavailable'),
    })
  })

  it('uses injected dependencies and call settings for eval runs', async () => {
    const getInjectedPublicContent = vi.fn(async () => ({
      about: {
        description: 'Injected public about copy',
      },
      career: [],
      projects: [],
    }))
    const getInjectedResumeContext = vi.fn(async () => ({
      available: true,
      source: 'blob' as const,
      content: 'Injected resume content',
    }))
    const searchInjectedWorkContext = vi.fn(async (query: string) => ({
      available: true,
      source: 'blob' as const,
      query,
      matches: [],
      content: 'Injected work context',
    }))
    const searchInjectedPersonalContext = vi.fn(async (query: string) => ({
      available: true,
      source: 'blob' as const,
      query,
      matches: [],
      content: 'Injected personal context',
    }))
    const { createAmaAgent } = await import('@/lib/ama-agent')

    const agent = createAmaAgent({
      getPublicSiteContent: getInjectedPublicContent,
      getResumeContext: getInjectedResumeContext,
      searchWorkContext: searchInjectedWorkContext,
      searchPersonalContext: searchInjectedPersonalContext,
      modelConfig: { model: 'openai/eval-model' },
      callSettings: {
        maxOutputTokens: 200,
        temperature: 0,
        seed: 7,
      },
    }) as {
      tools: Record<string, { execute?: (...args: unknown[]) => Promise<unknown> | unknown }>
    }

    expect(toolLoopAgentSettings[0]).toMatchObject({
      model: 'openai/eval-model',
      maxOutputTokens: 200,
      temperature: 0,
      seed: 7,
    })
    await expect(agent.tools.get_public_site_content.execute?.({})).resolves.toMatchObject({
      content: expect.stringContaining('Injected public about copy'),
    })
    await expect(agent.tools.get_resume.execute?.({})).resolves.toMatchObject({
      content: 'Injected resume content',
    })
    await expect(
      agent.tools.search_work_context.execute?.({ query: 'work routing' }),
    ).resolves.toMatchObject({
      query: 'work routing',
      content: 'Injected work context',
    })
    await expect(
      agent.tools.search_personal_context.execute?.({ query: 'personal routing' }),
    ).resolves.toMatchObject({
      query: 'personal routing',
      content: 'Injected personal context',
    })
  })

  it('does not duplicate retrieved excerpts in model-facing tool results', async () => {
    const excerpt = 'Fine-tuning flywheel implementation details.'
    const searchPersonalContext = vi.fn(async (query: string) => ({
      available: true,
      source: 'blob' as const,
      query,
      matches: [
        {
          pathname: 'personal/segov-dev.md',
          uploadedAt: '2026-08-02T00:00:00.000Z',
          size: 1234,
          score: 8,
          excerpt,
        },
      ],
      content: `Source: personal/segov-dev.md\n${excerpt}`,
    }))
    const { createAmaAgent } = await import('@/lib/ama-agent')
    const agent = createAmaAgent({ searchPersonalContext }) as {
      tools: Record<string, { execute?: (...args: unknown[]) => Promise<unknown> | unknown }>
    }

    const result = await agent.tools.search_personal_context.execute?.({
      query: 'How did you build the fine-tuning flywheel?',
    })
    const serializedResult = JSON.stringify(result)

    expect(result).toMatchObject({
      matches: [
        {
          pathname: 'personal/segov-dev.md',
          score: 8,
        },
      ],
      content: expect.stringContaining(excerpt),
    })
    expect((result as { matches: Array<Record<string, unknown>> }).matches[0]).not.toHaveProperty(
      'excerpt',
    )
    expect(serializedResult.split(excerpt)).toHaveLength(2)
  })
})
