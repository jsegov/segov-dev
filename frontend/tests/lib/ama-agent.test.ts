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
