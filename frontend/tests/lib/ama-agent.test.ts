import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AMA_CHAT_MODEL } from '@/lib/ama-model-config'

const { getPublicSiteContentMock, toolLoopAgentSettings } = vi.hoisted(() => ({
  getPublicSiteContentMock: vi.fn(),
  toolLoopAgentSettings: [] as Array<Record<string, unknown>>,
}))

vi.mock('ai', () => {
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
  })

  it('uses the default model and omits provider options when AMA_CHAT_PROVIDERS is unset', async () => {
    const { createAmaAgent } = await import('@/lib/ama-agent')

    createAmaAgent()

    expect(toolLoopAgentSettings).toHaveLength(1)
    expect(toolLoopAgentSettings[0]).toMatchObject({
      model: DEFAULT_AMA_CHAT_MODEL,
    })
    expect(toolLoopAgentSettings[0]?.providerOptions).toBeUndefined()
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
    expect(instructions).toContain('Work context disclosure policy')
    expect(instructions).toContain('Never include')
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
})
