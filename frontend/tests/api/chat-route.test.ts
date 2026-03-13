import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get as getBlob } from '@vercel/blob'

vi.mock('@vercel/blob', () => ({
  get: vi.fn(),
}))

vi.mock('ai', () => {
  class ToolLoopAgent {
    tools: Record<string, { execute?: (...args: unknown[]) => Promise<unknown> | unknown }>

    constructor(settings: {
      tools?: Record<string, { execute?: (...args: unknown[]) => Promise<unknown> | unknown }>
    }) {
      this.tools = settings.tools ?? {}
    }
  }

  return {
    gateway: (id: string) => id,
    tool: (definition: unknown) => definition,
    ToolLoopAgent,
    createAgentUIStreamResponse: vi.fn(
      async ({ agent, messages }: { agent: ToolLoopAgent; messages: unknown[] }) => {
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
    ),
  }
})

const getBlobMock = vi.mocked(getBlob)

describe('/api/chat route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.BLOB_RESUME_PATH
  })

  it('returns stream response for valid messages payload', async () => {
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

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('stream-ok')
  })

  it('handles missing BLOB_RESUME_PATH via deterministic fallback', async () => {
    const { POST } = await import('@/app/api/chat/route')

    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            {
              id: '1',
              role: 'user',
              parts: [{ type: 'text', text: 'RUN_GET_RESUME_TOOL' }],
            },
          ],
        }),
      }),
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
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            {
              id: '1',
              role: 'user',
              parts: [{ type: 'text', text: 'RUN_GET_RESUME_TOOL' }],
            },
          ],
        }),
      }),
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
})
