import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get as getBlob, list } from '@vercel/blob'
import { get as getEdgeConfig } from '@vercel/edge-config'
import { createAgentUIStreamResponse } from 'ai'
import type * as AmaTracesModule from '@/lib/ama-traces'

const { afterCallbacks, persistAmaTraceMock } = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<void>>,
  persistAmaTraceMock: vi.fn(),
}))

vi.mock('@vercel/blob', () => ({
  get: vi.fn(),
  list: vi.fn(),
}))

vi.mock('@vercel/edge-config', () => ({
  get: vi.fn(),
}))

vi.mock('next/server', () => ({
  after: vi.fn((callback: () => Promise<void>) => {
    afterCallbacks.push(callback)
  }),
}))

vi.mock('@/lib/ama-traces', async (importOriginal) => {
  const actual = await importOriginal<typeof AmaTracesModule>()
  return {
    ...actual,
    persistAmaTrace: persistAmaTraceMock,
  }
})

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()

  class ToolLoopAgent {
    settings: Record<string, unknown>
    tools: Record<string, { execute?: (...args: unknown[]) => Promise<unknown> | unknown }>

    constructor(
      settings: Record<string, unknown> & {
        tools?: Record<string, { execute?: (...args: unknown[]) => Promise<unknown> | unknown }>
      },
    ) {
      this.settings = settings
      this.tools = settings.tools ?? {}
    }
  }

  return {
    ...actual,
    gateway: (id: string) => id,
    tool: (definition: unknown) => definition,
    ToolLoopAgent,
    consumeStream: vi.fn(
      async ({
        stream,
        onError,
      }: {
        stream: ReadableStream<string>
        onError?: (error: unknown) => void
      }) => {
        const reader = stream.getReader()
        try {
          while (!(await reader.read()).done) {
            // Drain the stream.
          }
        } catch (error) {
          onError?.(error)
        }
      },
    ),
    createAgentUIStreamResponse: vi.fn(
      async ({
        agent,
        messages,
        uiMessages,
        consumeSseStream,
      }: {
        agent: ToolLoopAgent
        messages?: unknown[]
        uiMessages?: unknown[]
        consumeSseStream?: (options: { stream: ReadableStream<string> }) => Promise<void>
      }) => {
        const requestMessages = uiMessages ?? messages ?? []
        const firstMessage = requestMessages[0] as
          | { role?: string; parts?: Array<{ type?: string; text?: string }> }
          | undefined
        const firstText = firstMessage?.parts?.find((part) => part.type === 'text')?.text

        if (firstText === 'TRACE_COMPLETE' || firstText === 'TRACE_STREAM_ERROR') {
          const modelMessages = requestMessages.map((message) => {
            const uiMessage = message as {
              role: string
              parts?: Array<{ type?: string; text?: string }>
            }
            return {
              role: uiMessage.role,
              content:
                uiMessage.parts?.find((part) => part.type === 'text')?.text ?? 'message content',
            }
          })
          const prepareCall = agent.settings.prepareCall as
            | ((options: Record<string, unknown>) => unknown)
            | undefined
          prepareCall?.({
            ...agent.settings,
            prompt: modelMessages,
          })

          if (firstText === 'TRACE_COMPLETE') {
            const onFinish = agent.settings.onFinish as
              | ((event: Record<string, unknown>) => void)
              | undefined
            onFinish?.({
              finishReason: 'stop',
              providerMetadata: {
                gateway: {
                  provider: 'openai',
                },
              },
              response: {
                id: 'response-id',
                timestamp: new Date('2026-07-30T00:00:00.000Z'),
                modelId: 'openai/gpt-5.6-sol',
                messages: [
                  {
                    role: 'assistant',
                    content: [
                      {
                        type: 'tool-call',
                        toolCallId: 'call-1',
                        toolName: 'get_public_site_content',
                        input: { reason: 'answer the question' },
                      },
                    ],
                  },
                  {
                    role: 'tool',
                    content: [
                      {
                        type: 'tool-result',
                        toolCallId: 'call-1',
                        toolName: 'get_public_site_content',
                        output: {
                          type: 'json',
                          value: { available: true, content: 'Public context' },
                        },
                      },
                    ],
                  },
                  {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'I build AI tools.' }],
                  },
                ],
              },
              totalUsage: {
                inputTokens: 12,
                outputTokens: 8,
                totalTokens: 20,
              },
            })
          }

          const stream =
            firstText === 'TRACE_STREAM_ERROR'
              ? new ReadableStream<string>({
                  start(controller) {
                    controller.error(new Error('provider stream failed'))
                  },
                })
              : new ReadableStream<string>({
                  start(controller) {
                    controller.close()
                  },
                })
          void consumeSseStream?.({ stream })
        }

        if (firstText === 'RUN_GET_PUBLIC_SITE_CONTENT_TOOL') {
          const toolOutput = await agent.tools.get_public_site_content.execute?.({})
          return new Response(JSON.stringify(toolOutput), { status: 200 })
        }

        if (firstText === 'RUN_GET_RESUME_TOOL') {
          const toolOutput = await agent.tools.get_resume.execute?.({})
          return new Response(JSON.stringify(toolOutput), { status: 200 })
        }

        if (firstText === 'RUN_SEARCH_WORK_CONTEXT_TOOL') {
          const toolOutput = await agent.tools.search_work_context.execute?.({
            query: 'realtime architecture',
          })
          return new Response(JSON.stringify(toolOutput), { status: 200 })
        }

        if (firstText === 'RUN_SEARCH_PERSONAL_CONTEXT_TOOL') {
          const toolOutput = await agent.tools.search_personal_context.execute?.({
            query: 'side project build',
          })
          return new Response(JSON.stringify(toolOutput), { status: 200 })
        }

        return new Response('stream-ok', { status: 200 })
      },
    ),
  }
})

const getBlobMock = vi.mocked(getBlob)
const getEdgeConfigMock = vi.mocked(getEdgeConfig)
const listBlobMock = vi.mocked(list)
const createAgentUIStreamResponseMock = vi.mocked(createAgentUIStreamResponse)

function createListBlob(pathname: string) {
  return {
    pathname,
    url: `https://blob.example/${pathname}`,
    downloadUrl: `https://blob.example/download/${pathname}`,
    size: 123,
    uploadedAt: new Date('2025-01-01T00:00:00.000Z'),
    etag: `${pathname}-etag`,
  }
}

describe('/api/chat route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    afterCallbacks.length = 0
    persistAmaTraceMock.mockResolvedValue(undefined)
    delete process.env.BLOB_RESUME_PATH
    process.env.EDGE_CONFIG = 'https://edge-config.example'
    getEdgeConfigMock.mockResolvedValue({
      about: {
        description: 'Public about copy',
      },
      career: [
        {
          title: 'Software Engineer',
          companyName: 'Example Co',
          startDate: '2024-01-01',
          endDate: null,
          description: 'Built systems.',
          skills: ['TypeScript'],
        },
      ],
      projects: [
        {
          name: 'segov.dev',
          description: 'Portfolio site',
          skills: ['Next.js'],
          githubUrl: 'https://github.com/jsegov/segov-dev',
          websiteUrl: 'https://segov.dev',
        },
      ],
    })
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
    expect(createAgentUIStreamResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        uiMessages: [
          {
            id: '1',
            role: 'user',
            parts: [{ type: 'text', text: 'Hello' }],
          },
        ],
      }),
    )
  })

  it('returns the response before the after callback and Neon write finish', async () => {
    let finishWrite: (() => void) | undefined
    persistAmaTraceMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve
        }),
    )
    const { POST } = await import('@/app/api/chat/route')

    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          id: 'chat-id',
          trigger: 'submit-message',
          messages: [
            {
              id: 'conversation-user',
              role: 'user',
              parts: [{ type: 'text', text: 'TRACE_COMPLETE' }],
            },
          ],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('stream-ok')
    expect(afterCallbacks).toHaveLength(1)
    expect(persistAmaTraceMock).not.toHaveBeenCalled()

    let afterFinished = false
    const afterPromise = afterCallbacks[0]().then(() => {
      afterFinished = true
    })
    await vi.waitFor(() => {
      expect(persistAmaTraceMock).toHaveBeenCalledTimes(1)
    })
    expect(afterFinished).toBe(false)

    const trace = persistAmaTraceMock.mock.calls[0]?.[0]
    expect(trace).toMatchObject({
      conversationId: 'conversation-user',
      turn: 1,
      requestTrigger: 'submit-message',
      provider: 'openai',
      responseModel: 'openai/gpt-5.6-sol',
    })
    expect(trace.responseMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.arrayContaining([expect.objectContaining({ type: 'tool-call' })]),
        }),
        expect.objectContaining({
          role: 'tool',
          content: expect.arrayContaining([expect.objectContaining({ type: 'tool-result' })]),
        }),
      ]),
    )

    finishWrite?.()
    await afterPromise
    expect(afterFinished).toBe(true)
  })

  it('settles stream errors without attempting a partial trace write', async () => {
    const { POST } = await import('@/app/api/chat/route')

    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            {
              id: 'conversation-user',
              role: 'user',
              parts: [{ type: 'text', text: 'TRACE_STREAM_ERROR' }],
            },
          ],
        }),
      }),
    )

    expect(await response.text()).toBe('stream-ok')
    await afterCallbacks[0]()
    expect(persistAmaTraceMock).not.toHaveBeenCalled()
  })

  it('creates distinct trace IDs for regenerations of the same turn', async () => {
    const { POST } = await import('@/app/api/chat/route')
    const requestBody = {
      id: 'chat-id',
      trigger: 'regenerate-message',
      messages: [
        {
          id: 'conversation-user',
          role: 'user',
          parts: [{ type: 'text', text: 'TRACE_COMPLETE' }],
        },
      ],
    }

    await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify(requestBody),
      }),
    )
    await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify(requestBody),
      }),
    )
    await Promise.all(afterCallbacks.map((callback) => callback()))

    const firstTrace = persistAmaTraceMock.mock.calls[0]?.[0]
    const secondTrace = persistAmaTraceMock.mock.calls[1]?.[0]
    expect(firstTrace).toMatchObject({
      conversationId: 'conversation-user',
      turn: 1,
      requestTrigger: 'regenerate-message',
    })
    expect(secondTrace).toMatchObject({
      conversationId: 'conversation-user',
      turn: 1,
      requestTrigger: 'regenerate-message',
    })
    expect(firstTrace.id).not.toBe(secondTrace.id)
  })

  it('exercises public site content through the chat agent tool', async () => {
    const { POST } = await import('@/app/api/chat/route')

    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            {
              id: '1',
              role: 'user',
              parts: [{ type: 'text', text: 'RUN_GET_PUBLIC_SITE_CONTENT_TOOL' }],
            },
          ],
        }),
      }),
    )

    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({
      available: true,
      source: 'edge_config',
      content: expect.stringContaining('Public about copy'),
    })
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

  it('exercises work context search through the chat agent tool', async () => {
    listBlobMock.mockResolvedValueOnce({
      blobs: [createListBlob('work/design-doc.md')],
      hasMore: false,
    })
    getBlobMock.mockResolvedValueOnce({
      statusCode: 200,
      stream: new Response('Realtime architecture details for Jonathan employer.').body,
    } as Awaited<ReturnType<typeof getBlob>>)

    const { POST } = await import('@/app/api/chat/route')

    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            {
              id: '1',
              role: 'user',
              parts: [{ type: 'text', text: 'RUN_SEARCH_WORK_CONTEXT_TOOL' }],
            },
          ],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(listBlobMock).toHaveBeenCalledWith({ prefix: 'work/', cursor: undefined })
    const result = await response.json()
    expect(result).toMatchObject({
      available: true,
      source: 'blob',
      matches: [
        expect.objectContaining({
          pathname: 'work/design-doc.md',
        }),
      ],
    })
  })

  it('exercises personal context search through the chat agent tool', async () => {
    listBlobMock.mockResolvedValueOnce({
      blobs: [createListBlob('personal/side-project.md')],
      hasMore: false,
    })
    getBlobMock.mockResolvedValueOnce({
      statusCode: 200,
      stream: new Response('Side project build notes including scheduler details.').body,
    } as Awaited<ReturnType<typeof getBlob>>)

    const { POST } = await import('@/app/api/chat/route')

    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            {
              id: '1',
              role: 'user',
              parts: [{ type: 'text', text: 'RUN_SEARCH_PERSONAL_CONTEXT_TOOL' }],
            },
          ],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(listBlobMock).toHaveBeenCalledWith({ prefix: 'personal/', cursor: undefined })
    const result = await response.json()
    expect(result).toMatchObject({
      available: true,
      source: 'blob',
      matches: [
        expect.objectContaining({
          pathname: 'personal/side-project.md',
        }),
      ],
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

  it('returns 400 for unknown AI SDK request triggers', async () => {
    const { POST } = await import('@/app/api/chat/route')

    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          trigger: 'unknown-trigger',
          messages: [],
        }),
      }),
    )

    expect(response.status).toBe(400)
  })
})
