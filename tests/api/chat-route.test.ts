import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get as getBlob } from '@vercel/blob'
import { createAmaSessionCookieValue } from '@/lib/ama-session'
import { AMA_SESSION_COOKIE_NAME } from '@/lib/ama-routing'

const { createAgentUIStreamResponseMock } = vi.hoisted(() => ({
  createAgentUIStreamResponseMock: vi.fn(),
}))

vi.mock('@vercel/blob', () => ({
  get: vi.fn(),
}))

vi.mock('ai', () => {
  class ToolLoopAgent {
    model: string
    providerOptions: Record<string, unknown> | undefined
    tools: Record<string, { execute?: (...args: unknown[]) => Promise<unknown> | unknown }>

    constructor(settings: {
      model: string
      providerOptions?: Record<string, unknown>
      tools?: Record<string, { execute?: (...args: unknown[]) => Promise<unknown> | unknown }>
    }) {
      this.model = settings.model
      this.providerOptions = settings.providerOptions
      this.tools = settings.tools ?? {}
    }
  }

  return {
    gateway: (id: string) => id,
    tool: (definition: unknown) => definition,
    ToolLoopAgent,
    createAgentUIStreamResponse: createAgentUIStreamResponseMock,
  }
})

const getBlobMock = vi.mocked(getBlob)

describe('/api/chat route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.BLOB_RESUME_PATH
    process.env.AMA_SESSION_SECRET = 'test-secret'

    createAgentUIStreamResponseMock.mockImplementation(
      async ({
        agent,
        messages,
      }: {
        agent: {
          tools: Record<string, { execute?: (...args: unknown[]) => Promise<unknown> | unknown }>
        }
        messages: unknown[]
      }) => {
        const firstMessage = messages[0] as
          | { role?: string; parts?: Array<{ type?: string; text?: string }> }
          | undefined
        const firstText = firstMessage?.parts?.find((part) => part.type === 'text')?.text

        if (firstText === 'RUN_GET_RESUME_TOOL') {
          const toolOutput = await agent.tools.get_resume.execute?.({})
          return new Response(JSON.stringify(toolOutput), { status: 200 })
        }

        return new Response('stream-ok', { status: 200 })
      },
    )
  })

  it('returns stream response for valid messages payload', async () => {
    const { POST } = await import('@/app/api/chat/route')

    const response = await POST(
      createChatRequest(
        {
          messages: [
            {
              id: '1',
              role: 'user',
              parts: [{ type: 'text', text: 'Hello' }],
            },
          ],
        },
        createSessionCookie(),
      ),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('stream-ok')
  })

  it('handles missing BLOB_RESUME_PATH via deterministic fallback', async () => {
    const { POST } = await import('@/app/api/chat/route')

    const response = await POST(
      createChatRequest(
        {
          messages: [
            {
              id: '1',
              role: 'user',
              parts: [{ type: 'text', text: 'RUN_GET_RESUME_TOOL' }],
            },
          ],
        },
        createSessionCookie(),
      ),
    )

    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({
      available: false,
      source: 'missing_path',
    })
  })

  it('handles blob retrieval failure via deterministic fallback', async () => {
    process.env.BLOB_RESUME_PATH = 'resume/current.md'
    getBlobMock.mockRejectedValueOnce(new Error('blob unavailable'))

    const { POST } = await import('@/app/api/chat/route')

    const response = await POST(
      createChatRequest(
        {
          messages: [
            {
              id: '1',
              role: 'user',
              parts: [{ type: 'text', text: 'RUN_GET_RESUME_TOOL' }],
            },
          ],
        },
        createSessionCookie(),
      ),
    )

    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({
      available: false,
      source: 'blob_fetch_failed',
    })
  })

  it('returns 400 for invalid payloads', async () => {
    const { POST } = await import('@/app/api/chat/route')

    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    )

    expect(response.status).toBe(400)
  })

  it('retries with the fallback model when the primary stream setup fails', async () => {
    createAgentUIStreamResponseMock.mockImplementationOnce(async () => {
      throw new Error('primary failed')
    })

    const { POST } = await import('@/app/api/chat/route')

    const response = await POST(
      createChatRequest(
        {
          messages: [
            {
              id: '1',
              role: 'user',
              parts: [{ type: 'text', text: 'Hello' }],
            },
          ],
        },
        createSessionCookie({
          primaryModelId: 'openai/primary-fail',
          fallbackModelId: 'openai/fallback-model',
          fallbackProviderOrder: ['fallback-provider'],
        }),
      ),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('stream-ok')
    expect(createAgentUIStreamResponseMock).toHaveBeenCalledTimes(2)
    expect(createAgentUIStreamResponseMock.mock.calls[1]?.[0]?.agent.model).toBe(
      'openai/fallback-model',
    )
  })

  it('returns 503 when the ama session cookie is missing', async () => {
    const { POST } = await import('@/app/api/chat/route')

    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            {
              id: '1',
              role: 'user',
              parts: [{ type: 'text', text: 'Hello' }],
            },
          ],
        }),
      }),
    )

    expect(response.status).toBe(503)
    expect(await response.text()).toBe('AMA session unavailable.')
  })
})

function createSessionCookie({
  primaryModelId = 'openai/gpt-5-mini',
  primaryProviderOrder = ['openai'],
  fallbackModelId,
  fallbackProviderOrder = ['fallback'],
}: {
  primaryModelId?: string
  primaryProviderOrder?: string[]
  fallbackModelId?: string
  fallbackProviderOrder?: string[]
} = {}) {
  const value = createAmaSessionCookieValue({
    version: 1,
    createdAt: '2026-03-14T00:00:00.000Z',
    primary: {
      modelId: primaryModelId,
      providerOrder: primaryProviderOrder,
      defaultProvider: primaryProviderOrder[0],
      fallbackProvider: primaryProviderOrder[1],
    },
    fallback: fallbackModelId
      ? {
          modelId: fallbackModelId,
          providerOrder: fallbackProviderOrder,
          defaultProvider: fallbackProviderOrder[0],
          fallbackProvider: fallbackProviderOrder[1],
        }
      : undefined,
  })

  return `${AMA_SESSION_COOKIE_NAME}=${value}`
}

function createChatRequest(body: unknown, cookie?: string): Request {
  return {
    headers: new Headers(cookie ? { cookie } : undefined),
    json: async () => body,
  } as Request
}
