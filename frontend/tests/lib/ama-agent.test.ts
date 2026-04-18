import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AMA_CHAT_MODEL } from '@/lib/ama-model-config'

const { toolLoopAgentSettings } = vi.hoisted(() => ({
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

describe('createAmaAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toolLoopAgentSettings.length = 0
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

    expect(tools).toHaveProperty('get_resume')
    expect(tools).toHaveProperty('search_work_context')
    expect(tools).toHaveProperty('search_personal_context')
    expect(tools).not.toHaveProperty('search_ama_context')
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
})
