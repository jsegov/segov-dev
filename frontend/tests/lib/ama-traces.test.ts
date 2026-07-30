import { beforeEach, describe, expect, it, vi } from 'vitest'

const { neonMock, sqlTagMock, transactionMock } = vi.hoisted(() => {
  const transaction = vi.fn()
  const sqlTag = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join('?'),
    values,
  }))
  Object.assign(sqlTag, { transaction })

  return {
    neonMock: vi.fn(() => sqlTag),
    sqlTagMock: sqlTag,
    transactionMock: transaction,
  }
})

vi.mock('@neondatabase/serverless', () => ({
  neon: neonMock,
}))

import {
  createAmaTraceCollector,
  isRetryableAmaTraceError,
  persistAmaTrace,
  type AmaTracePayload,
} from '@/lib/ama-traces'
import { AMA_PROMPT_MANIFEST, AMA_SYSTEM_PROMPT_VERSION } from '@/lib/ama-agent'

const inputMessages = [
  {
    role: 'user',
    content: 'How did you build this site?',
  },
]
const responseMessages = [
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'search_personal_context',
        input: { query: 'segov.dev architecture' },
      },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'search_personal_context',
        output: {
          type: 'json',
          value: { available: true, content: 'server-only tool result' },
        },
      },
    ],
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'I built it with Next.js.' }],
  },
]

function createTrace(overrides: Partial<AmaTracePayload> = {}): AmaTracePayload {
  return {
    id: '019fb5bf-c1a4-78e4-8ff0-4d0a6aa3e27b',
    conversationId: 'conversation-1',
    turn: 1,
    requestTrigger: 'submit-message',
    deploymentEnvironment: 'test',
    systemPromptVersion: AMA_SYSTEM_PROMPT_VERSION,
    promptManifest: AMA_PROMPT_MANIFEST,
    model: 'openai/gpt-5.6-sol',
    responseModel: 'gpt-5.6-sol-2026-07-01',
    provider: null,
    inputMessages,
    responseMessages,
    totalUsage: {
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
    },
    finishReason: 'stop',
    ...overrides,
  } as AmaTracePayload
}

function createFinishEvent(provider?: string) {
  return {
    finishReason: 'stop',
    providerMetadata: provider
      ? {
          gateway: {
            provider,
          },
        }
      : undefined,
    response: {
      id: 'response-id',
      timestamp: new Date('2026-07-30T00:00:00.000Z'),
      modelId: 'gpt-5.6-sol-2026-07-01',
      messages: responseMessages,
    },
    totalUsage: {
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
    },
  }
}

describe('AMA trace collection', () => {
  it('captures exact converted inputs and complete tool-call/result response messages', async () => {
    const collector = createAmaTraceCollector({
      traceId: '019fb5bf-c1a4-78e4-8ff0-4d0a6aa3e27b',
      conversationId: 'conversation-1',
      requestTrigger: 'submit-message',
      deploymentEnvironment: 'production',
      model: 'openai/gpt-5.6-sol',
    })

    collector.prepareCall({
      prompt: inputMessages,
    } as Parameters<typeof collector.prepareCall>[0])
    collector.onFinish(createFinishEvent('openai') as Parameters<typeof collector.onFinish>[0])

    const trace = await collector.payload
    expect(trace).toMatchObject({
      id: '019fb5bf-c1a4-78e4-8ff0-4d0a6aa3e27b',
      conversationId: 'conversation-1',
      turn: 1,
      requestTrigger: 'submit-message',
      deploymentEnvironment: 'production',
      provider: 'openai',
      model: 'openai/gpt-5.6-sol',
      responseModel: 'gpt-5.6-sol-2026-07-01',
      finishReason: 'stop',
    })
    expect(trace?.inputMessages).toEqual(inputMessages)
    expect(trace?.responseMessages).toEqual(responseMessages)
    expect(Object.isFrozen(trace)).toBe(true)
    expect(Object.isFrozen(trace?.responseMessages)).toBe(true)
  })

  it('stores a null provider instead of guessing when Gateway metadata omits it', async () => {
    const collector = createAmaTraceCollector({
      conversationId: 'conversation-1',
      requestTrigger: 'submit-message',
      deploymentEnvironment: 'preview',
      model: 'openai/gpt-5.6-sol',
    })
    collector.prepareCall({
      prompt: inputMessages,
    } as Parameters<typeof collector.prepareCall>[0])
    collector.onFinish(createFinishEvent() as Parameters<typeof collector.onFinish>[0])

    await expect(collector.payload).resolves.toMatchObject({
      provider: null,
    })
  })

  it('settles once with null for incomplete streams and never accepts a later partial trace', async () => {
    const collector = createAmaTraceCollector({
      conversationId: 'conversation-1',
      requestTrigger: 'submit-message',
      deploymentEnvironment: 'development',
      model: 'openai/gpt-5.6-sol',
    })
    collector.prepareCall({
      prompt: inputMessages,
    } as Parameters<typeof collector.prepareCall>[0])

    collector.settleWithoutTrace()
    collector.onFinish(createFinishEvent('openai') as Parameters<typeof collector.onFinish>[0])

    await expect(collector.payload).resolves.toBeNull()
  })

  it('settles provider error finishes without producing a trace', async () => {
    const collector = createAmaTraceCollector({
      conversationId: 'conversation-1',
      requestTrigger: 'submit-message',
      deploymentEnvironment: 'production',
      model: 'openai/gpt-5.6-sol',
    })
    collector.prepareCall({
      prompt: inputMessages,
    } as Parameters<typeof collector.prepareCall>[0])

    collector.onFinish({
      ...createFinishEvent('openai'),
      finishReason: 'error',
    } as Parameters<typeof collector.onFinish>[0])

    await expect(collector.payload).resolves.toBeNull()
  })
})

describe('AMA trace persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    transactionMock.mockResolvedValue([[], []])
    neonMock.mockReturnValue(sqlTagMock)
  })

  it('writes the prompt manifest and trace in one idempotent HTTP transaction with JSON fidelity', async () => {
    const trace = createTrace()

    await persistAmaTrace(trace, {
      databaseUrl: 'postgresql://example.test/neondb',
    })

    expect(neonMock).toHaveBeenCalledWith('postgresql://example.test/neondb')
    expect(transactionMock).toHaveBeenCalledTimes(1)
    const [queries, transactionOptions] = transactionMock.mock.calls[0]!
    expect(queries).toHaveLength(2)
    expect(queries[0].text).toContain('ON CONFLICT (version) DO NOTHING')
    expect(queries[1].text).toContain('ON CONFLICT (id) DO NOTHING')
    expect(JSON.parse(queries[0].values[2])).toEqual(AMA_PROMPT_MANIFEST.tools)
    expect(JSON.parse(queries[0].values[3])).toEqual(AMA_PROMPT_MANIFEST.callSettings)
    expect(JSON.parse(queries[1].values[9])).toEqual(inputMessages)
    expect(JSON.parse(queries[1].values[10])).toEqual(responseMessages)
    expect(JSON.parse(queries[1].values[11])).toEqual(trace.totalUsage)
    expect(transactionOptions.fetchOptions.signal).toBeInstanceOf(AbortSignal)

    await persistAmaTrace(trace, {
      databaseUrl: 'postgresql://example.test/neondb',
    })
    expect(transactionMock).toHaveBeenCalledTimes(2)
    expect(transactionMock.mock.calls[1]?.[0]?.[1]?.values[0]).toBe(trace.id)
  })

  it('retries transient writes independently with exponential jittered backoff', async () => {
    const transientError = Object.assign(new Error('connection dropped'), { code: '08006' })
    const writer = vi
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce(undefined)
    const sleep = vi.fn().mockResolvedValue(undefined)
    const logFailure = vi.fn()

    await persistAmaTrace(createTrace(), {
      writer,
      sleep,
      random: () => 0,
      logFailure,
    })

    expect(writer).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenNthCalledWith(1, 250)
    expect(sleep).toHaveBeenNthCalledWith(2, 500)
    expect(logFailure).not.toHaveBeenCalled()
  })

  it('stops immediately on permanent Postgres failures and logs no trace content', async () => {
    const writer = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('unique violation'), { code: '23505' }))
    const logFailure = vi.fn()
    const trace = createTrace()

    await persistAmaTrace(trace, {
      writer,
      sleep: vi.fn(),
      logFailure,
    })

    expect(writer).toHaveBeenCalledTimes(1)
    expect(logFailure).toHaveBeenCalledWith({
      event: 'ama_trace_write_failed',
      traceId: trace.id,
      attemptCount: 1,
      errorName: 'Error',
      errorCode: '23505',
      environment: 'test',
    })
    expect(JSON.stringify(logFailure.mock.calls)).not.toContain('server-only tool result')
    expect(JSON.stringify(logFailure.mock.calls)).not.toContain('How did you build this site?')
  })

  it('logs once after three exhausted transient attempts', async () => {
    const writer = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('service unavailable'), { status: 503 }))
    const logFailure = vi.fn()

    await persistAmaTrace(createTrace(), {
      writer,
      sleep: vi.fn().mockResolvedValue(undefined),
      random: () => 0,
      logFailure,
    })

    expect(writer).toHaveBeenCalledTimes(3)
    expect(logFailure).toHaveBeenCalledTimes(1)
    expect(logFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ama_trace_write_failed',
        attemptCount: 3,
      }),
    )
  })

  it('aborts and retries writes that exceed the per-attempt timeout', async () => {
    const writer = vi.fn(
      (_trace: AmaTracePayload, signal: AbortSignal) =>
        new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const logFailure = vi.fn()

    await persistAmaTrace(createTrace(), {
      writer,
      sleep: vi.fn().mockResolvedValue(undefined),
      timeoutMs: 5,
      logFailure,
    })

    expect(writer).toHaveBeenCalledTimes(3)
    expect(logFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptCount: 3,
        errorName: 'AmaTraceTimeoutError',
        errorCode: 'ETIMEDOUT',
      }),
    )
  })

  it('handles missing configuration and the kill switch without throwing', async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL
    const logFailure = vi.fn()
    delete process.env.DATABASE_URL

    try {
      await expect(
        persistAmaTrace(createTrace(), {
          logFailure,
        }),
      ).resolves.toBeUndefined()
      expect(logFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptCount: 0,
          errorCode: 'AMA_TRACE_DATABASE_URL_MISSING',
        }),
      )

      logFailure.mockClear()
      await expect(
        persistAmaTrace(createTrace(), {
          enabled: false,
          logFailure,
        }),
      ).resolves.toBeUndefined()
      expect(logFailure).not.toHaveBeenCalled()
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl
      }
    }
  })

  it.each([
    [Object.assign(new Error('network'), { code: 'ECONNRESET' }), true],
    [Object.assign(new Error('request timeout'), { statusCode: 408 }), true],
    [Object.assign(new Error('rate limit'), { status: 429 }), true],
    [Object.assign(new Error('rollback'), { code: '40001' }), true],
    [Object.assign(new Error('locked'), { code: '55P03' }), true],
    [Object.assign(new Error('restart'), { code: '57P02' }), true],
    [Object.assign(new Error('authentication'), { code: '28P01' }), false],
    [Object.assign(new Error('constraint'), { code: '23503' }), false],
    [Object.assign(new Error('schema'), { code: '42P01' }), false],
  ])('classifies retryability for %#', (error, expected) => {
    expect(isRetryableAmaTraceError(error)).toBe(expected)
  })
})
