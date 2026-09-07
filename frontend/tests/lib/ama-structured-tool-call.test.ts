import { ToolLoopAgent, stepCountIs, tool, type wrapLanguageModel } from 'ai'
import { MockLanguageModelV3, convertReadableStreamToArray, simulateReadableStream } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { withAmaStructuredToolCall } from '@/lib/ama-structured-tool-call'

type Model = Parameters<typeof wrapLanguageModel>[0]['model']
type StreamResult = Awaited<ReturnType<Model['doStream']>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never
const declaration = {
  name: 'search_work_context',
  description: 'Search private work context.',
  inputSchema: z.toJSONSchema(
    z.object({ query: z.string().min(1), reason: z.string().optional() }),
  ),
}
const usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 12, text: 10, reasoning: 2 },
}
const finish: Extract<StreamPart, { type: 'finish' }> = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'provider-stop' },
  usage,
  providerMetadata: { inference: { diagnostic: 'PRIVATE_PROVIDER_METADATA' } },
}
const request = {
  prompt: [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'My architecture?' }] },
  ],
  tools: [{ type: 'function' as const, ...declaration }],
  toolChoice: { type: 'required' as const },
}

function chunks(rawJson: string, terminal: StreamPart = finish): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'response-id' },
    { type: 'text-start', id: 'arguments' },
    ...rawJson.split('').map((delta) => ({ type: 'text-delta' as const, id: 'arguments', delta })),
    { type: 'text-end', id: 'arguments' },
    terminal,
  ]
}

function stream(parts: StreamPart[]): StreamResult {
  return {
    stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: null }),
    request: { body: 'PRIVATE_REQUEST' },
    response: { headers: { 'x-response-id': 'response-id' } },
  }
}

function wrapped(model: MockLanguageModelV3, selected = declaration): Model {
  return withAmaStructuredToolCall(model, selected) as Model
}

describe('AMA constrained forced retrieval', () => {
  it('requests one strict argument object without changing eligible tool context or generation settings', async () => {
    const rawJson = '{"query":"My architecture?"}'
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: rawJson }],
        finishReason: finish.finishReason,
        providerMetadata: finish.providerMetadata,
        usage,
        warnings: [],
      }),
    })
    const signal = new AbortController().signal
    const result = await wrapped(model).doGenerate({
      ...request,
      maxOutputTokens: 512,
      abortSignal: signal,
    })

    expect(model.doGenerateCalls[0]).toMatchObject({
      tools: request.tools,
      toolChoice: { type: 'none' },
      maxOutputTokens: 512,
      abortSignal: signal,
      responseFormat: {
        type: 'json',
        name: 'ama_tool_arguments',
        schema: {
          type: 'object',
          properties: { query: { type: 'string', minLength: 1, maxLength: 2000 } },
          required: ['query'],
          additionalProperties: false,
        },
      },
    })
    expect(model.doGenerateCalls[0]?.prompt[0]).toMatchObject({ role: 'system' })
    expect(model.doGenerateCalls[0]?.prompt.at(-1)).toEqual(request.prompt[0])
    expect(result.content).toEqual([
      {
        type: 'tool-call',
        toolCallId: expect.stringMatching(/^ama-context-/),
        toolName: declaration.name,
        input: rawJson,
        providerMetadata: {
          ...finish.providerMetadata,
          amaStructuredToolCall: { rawJson, finishReason: finish.finishReason },
        },
      },
    ])
    expect(result.usage).toEqual(usage)
    expect(result.finishReason).toEqual(finish.finishReason)
  })

  it('buffers fragmented arguments until finish, then emits one complete SDK tool lifecycle', async () => {
    const rawJson = String.raw`{"query":"A \"quoted\" path: recovery\n\ud83d\udcc2"}`
    const model = new MockLanguageModelV3({ doStream: async () => stream(chunks(rawJson)) })
    const result = await wrapped(model).doStream(request)
    const parts = await convertReadableStreamToArray(result.stream)
    const toolCall = parts.find((part) => part.type === 'tool-call')!
    expect(parts.map((part) => part.type)).toEqual([
      'stream-start',
      'response-metadata',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-end',
      'tool-call',
      'finish',
    ])
    expect(toolCall).toMatchObject({
      input: rawJson,
      toolName: declaration.name,
      providerMetadata: { amaStructuredToolCall: { rawJson, finishReason: finish.finishReason } },
    })
    expect(parts[2]).toMatchObject({ id: toolCall.toolCallId, toolName: declaration.name })
    expect(parts[3]).toMatchObject({ id: toolCall.toolCallId, delta: rawJson })
    expect(parts[4]).toMatchObject({ id: toolCall.toolCallId })
    expect(parts.at(-1)).toEqual(finish)
    expect(result.request).toEqual({ body: 'PRIVATE_REQUEST' })
    expect(result.response).toEqual({ headers: { 'x-response-id': 'response-id' } })
  })

  it.each(['get_public_site_content', 'get_resume'])(
    'uses an empty argument object for %s',
    async (name) => {
      const selected = { ...declaration, name, inputSchema: z.toJSONSchema(z.object({})) }
      const model = new MockLanguageModelV3({ doStream: async () => stream(chunks('{}')) })
      const result = await wrapped(model, selected).doStream({
        ...request,
        tools: [{ type: 'function', ...selected }],
      })
      const parts = await convertReadableStreamToArray(result.stream)
      expect(parts.filter((part) => part.type === 'tool-call')).toEqual([
        expect.objectContaining({ toolName: name, input: '{}' }),
      ])
      expect(model.doStreamCalls[0]?.responseFormat).toMatchObject({
        schema: { type: 'object', properties: {}, additionalProperties: false },
      })
    },
  )

  it.each([
    '{}',
    'null',
    '[]',
    '{"query":42}',
    '{"query":""}',
    '{"query":"  \\t"}',
    JSON.stringify({ query: 'q'.repeat(2001) }),
    '{"query":"one","query":"two"}',
    '{"query":"q","reason":"unneeded"}',
    '{"query":"PRIVATE_UNFINISHED',
    'not JSON',
    'x'.repeat(65537),
  ])(
    'rejects invalid complete arguments without inventing an attempted call (%#)',
    async (rawJson) => {
      const model = new MockLanguageModelV3({ doStream: async () => stream(chunks(rawJson)) })
      const result = await wrapped(model).doStream(request)
      const parts = await convertReadableStreamToArray(result.stream)
      expect(parts.some((part) => part.type === 'tool-call' || part.type.startsWith('text-'))).toBe(
        false,
      )
      expect(parts.find((part) => part.type === 'error')).toMatchObject({
        error: { name: 'AmaStructuredToolCallError', message: 'AMA_ERROR:provider_response' },
      })
      expect(parts.at(-1)).toMatchObject({
        ...finish,
        providerMetadata: {
          ...finish.providerMetadata,
          amaStructuredToolCall: {
            rawJson: rawJson.slice(0, 65536),
            finishReason: finish.finishReason,
            converted: false,
          },
        },
      })
    },
  )

  it('does not execute complete JSON when the provider reports truncation', async () => {
    const truncated: StreamPart = {
      ...finish,
      finishReason: { unified: 'length', raw: 'max_tokens' },
    }
    const model = new MockLanguageModelV3({
      doStream: async () => stream(chunks('{"query":"q"}', truncated)),
    })
    const result = await wrapped(model).doStream(request)
    const parts = await convertReadableStreamToArray(result.stream)
    expect(parts.some((part) => part.type === 'tool-call')).toBe(false)
    expect(parts.some((part) => part.type === 'error')).toBe(true)
    expect(parts.at(-1)).toMatchObject(truncated)
  })

  it('rejects non-streaming invalid or truncated JSON before any SDK call is fabricated', async () => {
    for (const [rawJson, finishReason] of [
      ['{"query":42}', finish.finishReason],
      ['{"query":"complete"}', { unified: 'length', raw: 'max_tokens' }],
    ] as const) {
      const model = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text: rawJson }],
          finishReason,
          usage,
          warnings: [],
        }),
      })
      await expect(wrapped(model).doGenerate(request)).rejects.toMatchObject({
        name: 'AmaStructuredToolCallError',
        message: 'AMA_ERROR:provider_response',
      })
    }
  })

  it('rejects post-finish frames without synthesizing another call or publishing argument text', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () =>
        stream([
          ...chunks('{"query":"a question"}'),
          finish,
          { type: 'text-start', id: 'extra' },
          { type: 'text-delta', id: 'extra', delta: 'PRIVATE_EXTRA_ARGUMENTS' },
          { type: 'text-end', id: 'extra' },
        ]),
    })
    const parts = await convertReadableStreamToArray(
      (await wrapped(model).doStream(request)).stream,
    )
    expect(parts.filter((part) => part.type === 'tool-call')).toHaveLength(1)
    expect(parts.filter((part) => part.type === 'finish')).toHaveLength(1)
    expect(parts.some((part) => part.type === 'error')).toBe(true)
    expect(parts.some((part) => part.type.startsWith('text-'))).toBe(false)
  })

  it('retains non-streaming native duplicates unchanged and audits suppressed raw argument text', async () => {
    const native = ['native-first', 'native-second'].map((toolCallId) => ({
      type: 'tool-call' as const,
      toolCallId,
      toolName: declaration.name,
      input: '{"query":"native request"}',
    }))
    const rawJson = '{"query":"PRIVATE_RAW_DECISION"}'
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: rawJson }, ...native],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage,
        warnings: [],
      }),
    })
    const result = await wrapped(model).doGenerate(request)
    expect(result.content).toMatchObject(native)
    for (const part of result.content) {
      expect(part.providerMetadata).toMatchObject({
        amaStructuredToolCall: { rawJson, converted: false },
      })
    }
    expect(result.providerMetadata).toMatchObject({
      amaStructuredToolCall: {
        rawJson,
        converted: false,
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      },
    })
  })

  it('retains every unexpected native attempt and reasoning without replacing them with a constrained call', async () => {
    const native: StreamPart[] = [
      { type: 'reasoning-start', id: 'reason' },
      { type: 'reasoning-delta', id: 'reason', delta: 'PRIVATE_REASONING' },
      { type: 'reasoning-end', id: 'reason' },
      ...['first', 'duplicate'].flatMap((id): StreamPart[] => [
        { type: 'tool-input-start', id, toolName: declaration.name },
        { type: 'tool-input-delta', id, delta: '{"query":"repeat"}' },
        { type: 'tool-input-end', id },
        {
          type: 'tool-call',
          toolCallId: id,
          toolName: declaration.name,
          input: '{"query":"repeat"}',
        },
      ]),
    ]
    const original: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      ...native,
      { ...finish, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
    ]
    const model = new MockLanguageModelV3({ doStream: async () => stream(original) })
    const result = await wrapped(model).doStream(request)
    const parts = await convertReadableStreamToArray(result.stream)
    expect(parts.filter((part) => part.type !== 'tool-call' && part.type !== 'finish')).toEqual(
      original.filter((part) => part.type !== 'tool-call' && part.type !== 'finish'),
    )
    expect(parts.filter((part) => part.type === 'tool-call')).toMatchObject(
      original.filter((part) => part.type === 'tool-call'),
    )
    expect(parts.at(-1)).toMatchObject(original.at(-1)!)
  })

  it('preserves explicit provider errors and detects missing finishes without leaking argument text', async () => {
    const providerError = new Error('PRIVATE_PROVIDER_ERROR')
    const original: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'error', error: providerError },
      { ...finish, finishReason: { unified: 'error', raw: 'upstream' } },
    ]
    const errorModel = new MockLanguageModelV3({ doStream: async () => stream(original) })
    const errorParts = await convertReadableStreamToArray(
      (await wrapped(errorModel).doStream(request)).stream,
    )
    expect(errorParts.slice(0, -1)).toEqual(original.slice(0, -1))
    expect(errorParts.at(-1)).toMatchObject(original.at(-1)!)
    const missingFinishModel = new MockLanguageModelV3({
      doStream: async () => stream(chunks('{"query":"PRIVATE_QUERY"}').slice(0, -1)),
    })
    const parts = await convertReadableStreamToArray(
      (await wrapped(missingFinishModel).doStream(request)).stream,
    )
    expect(parts.some((part) => part.type === 'tool-call' || part.type.startsWith('text-'))).toBe(
      false,
    )
    expect(parts.at(-1)).toMatchObject({ type: 'error' })
  })

  it('retains native attempts and their raw audit when the provider omits its finish', async () => {
    const rawJson = '{"query":"PRIVATE_LATE_JSON"}'
    const native: StreamPart = {
      type: 'tool-call',
      toolCallId: 'native-without-finish',
      toolName: declaration.name,
      input: '{"query":"original native arguments"}',
    }
    const model = new MockLanguageModelV3({
      doStream: async () =>
        stream([{ type: 'stream-start', warnings: [] }, native, ...chunks(rawJson).slice(2, -1)]),
    })
    const parts = await convertReadableStreamToArray(
      (await wrapped(model).doStream(request)).stream,
    )
    expect(parts.filter((part) => part.type === 'tool-call')).toEqual([
      {
        ...native,
        providerMetadata: {
          amaStructuredToolCall: {
            rawJson,
            rawJsonTruncated: false,
            finishReason: null,
            converted: false,
          },
        },
      },
    ])
    expect(parts.at(-1)).toMatchObject({ type: 'error' })
    expect(parts.some((part) => part.type === 'finish' || part.type.startsWith('text-'))).toBe(
      false,
    )
  })

  it('persists suppressed late argument JSON on the original native call in real SDK response history', async () => {
    const rawJson = '{"query":"PRIVATE_LATE_DECISION"}'
    const native: StreamPart = {
      type: 'tool-call',
      toolCallId: 'native-audit-id',
      toolName: declaration.name,
      input: '{"query":"actual native query"}',
      providerMetadata: { inference: { native: 'PRIVATE_NATIVE_METADATA' } },
    }
    const source = new MockLanguageModelV3({
      doStream: async () =>
        stream([
          { type: 'stream-start', warnings: [] },
          native,
          ...chunks(rawJson, {
            ...finish,
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          }).slice(2),
        ]),
    })
    const answer = new MockLanguageModelV3({ doStream: async () => stream(chunks('Final answer')) })
    const execute = vi.fn(async (_input: { query: string }) => 'PRIVATE_FOUND_CONTEXT')
    const onFinish = vi.fn()
    const agent = new ToolLoopAgent({
      model: withAmaStructuredToolCall(source, declaration),
      stopWhen: stepCountIs(2),
      tools: {
        search_work_context: tool({ inputSchema: z.object({ query: z.string().min(1) }), execute }),
      },
      prepareStep: ({ stepNumber }) =>
        stepNumber === 0
          ? { toolChoice: 'required' as const, activeTools: ['search_work_context'] }
          : { model: answer, toolChoice: 'none' as const, activeTools: [] },
      onFinish,
    })
    const result = await agent.stream({ prompt: 'Question' })
    await result.consumeStream()
    expect(execute.mock.calls.map(([input]) => input)).toEqual([{ query: 'actual native query' }])
    const steps = await result.steps
    expect(steps[0]?.toolCalls).toHaveLength(1)
    expect(steps[0]?.toolCalls[0]).toMatchObject({
      toolCallId: 'native-audit-id',
      input: { query: 'actual native query' },
      providerMetadata: { amaStructuredToolCall: { rawJson, converted: false } },
    })
    expect(JSON.stringify(onFinish.mock.calls[0]?.[0].response.messages)).toContain(
      'PRIVATE_LATE_DECISION',
    )
    expect(JSON.stringify(onFinish.mock.calls[0]?.[0].response.messages)).toContain(
      'PRIVATE_NATIVE_METADATA',
    )
    expect(await result.text).toBe('Final answer')
  })

  it('lets the real SDK validate and execute once, retain private metadata, and continue with the result', async () => {
    const rawJson = '{"query":"My architecture?"}'
    const source = new MockLanguageModelV3({ doStream: async () => stream(chunks(rawJson)) })
    const answer = new MockLanguageModelV3({ doStream: async () => stream(chunks('Final answer')) })
    const execute = vi.fn(async (_input: { query: string }) => ({
      source: 'work',
      content: 'PRIVATE_FOUND_CONTEXT',
    }))
    const onFinish = vi.fn()
    const agent = new ToolLoopAgent({
      model: withAmaStructuredToolCall(source, declaration),
      stopWhen: stepCountIs(2),
      tools: {
        search_work_context: tool({ inputSchema: z.object({ query: z.string().min(1) }), execute }),
      },
      prepareStep: ({ stepNumber }) =>
        stepNumber === 0
          ? { toolChoice: 'required' as const, activeTools: ['search_work_context'] }
          : { model: answer, toolChoice: 'none' as const, activeTools: [] },
      onFinish,
    })
    const result = await agent.stream({ prompt: 'My architecture?' })
    await result.consumeStream()
    expect(await result.text).toBe('Final answer')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toEqual({ query: 'My architecture?' })
    const steps = await result.steps
    expect(steps).toHaveLength(2)
    expect(steps[0]?.toolCalls).toHaveLength(1)
    expect(steps[0]?.toolCalls[0]).toMatchObject({
      providerMetadata: { amaStructuredToolCall: { rawJson, finishReason: finish.finishReason } },
    })
    expect(steps[0]?.toolCalls[0]?.invalid).not.toBe(true)
    expect(JSON.stringify(answer.doStreamCalls[0]?.prompt)).toContain('PRIVATE_FOUND_CONTEXT')
    expect(JSON.stringify(onFinish.mock.calls)).toContain('amaStructuredToolCall')
  })

  it('propagates cancellation and refuses to broaden the allowed tool set', async () => {
    const cancel = vi.fn()
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
          },
          cancel,
        }),
      }),
    })
    const controller = new AbortController()
    const result = await wrapped(model).doStream({ ...request, abortSignal: controller.signal })
    const reader = result.stream.getReader()
    await reader.read()
    await reader.cancel('client stopped')
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('client stopped'))
    expect(model.doStreamCalls[0]?.abortSignal).toBe(controller.signal)
    await expect(wrapped(model).doStream({ ...request, tools: [] })).rejects.toMatchObject({
      name: 'AmaStructuredToolCallError',
    })
    expect(model.doStreamCalls).toHaveLength(1)
  })
})
