import type { wrapLanguageModel } from 'ai'
import { MockLanguageModelV3, convertReadableStreamToArray, simulateReadableStream } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withAmaInferenceReliability } from '@/lib/ama-model-reliability'
import { withAmaStructuredAnswer } from '@/lib/ama-structured-answer'

type Model = Parameters<typeof wrapLanguageModel>[0]['model']
type StreamResult = Awaited<ReturnType<Model['doStream']>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never
type GenerateResult = Awaited<ReturnType<Model['doGenerate']>>

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 12, text: 10, reasoning: 2 },
}
const finish: Extract<StreamPart, { type: 'finish' }> = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage,
  providerMetadata: { inference: { latency: 12 } },
}
const request = { prompt: [], toolChoice: { type: 'none' as const } }

function wrapped(model: MockLanguageModelV3): Model {
  return withAmaStructuredAnswer(model) as Model
}

function streamResult(chunks: StreamPart[]): StreamResult {
  return {
    stream: simulateReadableStream({ chunks, chunkDelayInMs: null }),
    request: { body: 'provider request' },
    response: { headers: { 'x-request-id': 'provider-id' } },
  }
}

function textChunks(deltas: string[]): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'provider-id' },
    { type: 'text-start', id: 'answer' },
    ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 'answer', delta })),
    { type: 'text-end', id: 'answer', providerMetadata: { inference: { part: 1 } } },
    finish,
  ]
}

function generated(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text, providerMetadata: { inference: { part: 1 } } }],
    finishReason: finish.finishReason,
    usage,
    warnings: [],
    request: { body: 'provider request' },
    response: { id: 'provider-id', headers: { 'x-request-id': 'provider-id' } },
    providerMetadata: finish.providerMetadata,
  }
}

function textOf(parts: StreamPart[]): string {
  return parts.flatMap((part) => (part.type === 'text-delta' ? [part.delta] : [])).join('')
}

async function collectFailure(stream: ReadableStream<StreamPart>) {
  const reader = stream.getReader()
  const parts: StreamPart[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        return { parts, error: undefined }
      }
      parts.push(value)
    }
  } catch (error) {
    return { parts, error }
  } finally {
    reader.releaseLock()
  }
}

describe('AMA structured terminal answer', () => {
  afterEach(() => vi.restoreAllMocks())

  it('requests the strict schema on the same model, preserving prompt roles and call settings', async () => {
    const rawJson = JSON.stringify({ answer: 'A supported answer.' })
    const model = new MockLanguageModelV3({ doGenerate: async () => generated(rawJson) })
    const prompt: Parameters<Model['doGenerate']>[0]['prompt'] = [
      { role: 'system', content: 'Keep private facts private.' },
      { role: 'user', content: [{ type: 'text', text: 'A question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Prior answer' }] },
      { role: 'system', content: 'Retrieved-source restrictions.' },
    ]
    const abortController = new AbortController()
    const options = {
      ...request,
      prompt,
      maxOutputTokens: 123,
      abortSignal: abortController.signal,
      headers: { 'x-test': 'same-call' },
    }
    const answer = await wrapped(model).doGenerate(options)

    expect(model.doGenerateCalls).toHaveLength(1)
    expect(model.doGenerateCalls[0]).toMatchObject({
      ...options,
      prompt: [
        prompt[0],
        prompt[1],
        prompt[2],
        { role: 'system', content: expect.stringContaining('Retrieved-source restrictions.') },
      ],
      responseFormat: {
        type: 'json',
        name: 'ama_answer',
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        },
      },
    })
    expect(prompt[3]).toEqual({ role: 'system', content: 'Retrieved-source restrictions.' })
    expect(answer.content).toEqual([
      {
        type: 'text',
        text: 'A supported answer.',
        providerMetadata: {
          inference: { part: 1 },
          amaStructuredAnswer: { rawJson },
        },
      },
    ])
    expect(answer).toMatchObject({
      usage,
      finishReason: finish.finishReason,
      providerMetadata: finish.providerMetadata,
      request: { body: 'provider request' },
      response: { id: 'provider-id' },
      warnings: [],
    })
  })

  it.each([
    JSON.stringify({ answer: 'Quotes " and slash \\; newline\n tab\t; naïve 😀.' }),
    '{"answer":"Escaped \\uD83D\\uDE00 and \\u00e9; \\"quotes\\"."}',
  ])(
    'decodes character-fragmented escapes without duplicate or broken Unicode deltas',
    async (rawJson) => {
      const model = new MockLanguageModelV3({
        doStream: async () => streamResult(textChunks(rawJson.split(''))),
      })
      const result = await wrapped(model).doStream(request)
      const parts = await convertReadableStreamToArray(result.stream)
      const deltas = parts.filter((part) => part.type === 'text-delta')

      expect(textOf(parts)).toBe(JSON.parse(rawJson).answer)
      expect(deltas.every((part) => !/[\uD800-\uDBFF]$/.test(part.delta))).toBe(true)
      expect(parts.filter((part) => part.type === 'text-start')).toHaveLength(1)
      expect(parts.filter((part) => part.type === 'text-end')).toEqual([
        {
          type: 'text-end',
          id: 'answer',
          providerMetadata: {
            inference: { part: 1 },
            amaStructuredAnswer: { rawJson },
          },
        },
      ])
      expect(parts.at(-1)).toEqual(finish)
      expect(result.request).toEqual({ body: 'provider request' })
      expect(result.response).toEqual({ headers: { 'x-request-id': 'provider-id' } })
      expect(model.doStreamCalls[0].prompt[0]).toMatchObject({ role: 'system' })
    },
  )

  it('preserves reasoning, provider metadata, and raw finish reason alongside the answer', async () => {
    const rawJson = '{"answer":"Visible answer"}'
    const reasoning: StreamPart[] = [
      { type: 'reasoning-start', id: 'reason' },
      { type: 'reasoning-delta', id: 'reason', delta: 'Private reasoning' },
      { type: 'reasoning-end', id: 'reason' },
    ]
    const chunks = textChunks([rawJson])
    chunks.splice(2, 0, ...reasoning)
    chunks[chunks.length - 1] = {
      ...finish,
      finishReason: { unified: 'length', raw: 'max_tokens' },
    }
    const model = new MockLanguageModelV3({ doStream: async () => streamResult(chunks) })
    const result = await wrapped(model).doStream(request)
    const parts = await convertReadableStreamToArray(result.stream)
    expect(parts.filter((part) => part.type.startsWith('reasoning-'))).toEqual(reasoning)
    expect(parts.at(-1)).toEqual(chunks.at(-1))
    expect(textOf(parts)).toBe('Visible answer')
  })

  it.each([
    '{"answer":42}',
    '{"answer":null}',
    '{"answer":{}}',
    '{"other":"private non-answer"}',
    '{"answer":"Visible","extra":"forbidden envelope field"}',
    '{"answer":"   "}',
    '{"answer":"Unfinished',
    '{"answer":"Orphan \\ud800"}',
    'not JSON',
    'x'.repeat(65537),
  ])('fails safely for invalid or truncated output (%#)', async (rawJson) => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => generated(rawJson),
      doStream: async () => streamResult(textChunks([rawJson])),
    })
    await expect(wrapped(model).doGenerate(request)).rejects.toMatchObject({
      name: 'AmaStructuredAnswerError',
      message: 'AMA_ERROR:provider_response',
    })
    const result = await wrapped(model).doStream(request)
    const { parts, error } = await collectFailure(result.stream)
    expect(error).toMatchObject({
      name: 'AmaStructuredAnswerError',
      message: 'AMA_ERROR:provider_response',
    })
    expect(parts.some((part) => part.type === 'finish' || part.type === 'text-end')).toBe(false)
    expect(textOf(parts)).not.toContain('"answer":')
    expect(textOf(parts)).not.toContain('private non-answer')
    expect(textOf(parts)).not.toContain('forbidden envelope field')
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(model.doStreamCalls).toHaveLength(1)
  })

  it('rejects a partial answer revision instead of duplicating or silently replacing text', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => streamResult(textChunks(['{"answer":"First"', ',"answer":"Second"}'])),
    })
    const { stream } = await wrapped(model).doStream(request)
    const { parts, error } = await collectFailure(stream)
    expect(textOf(parts)).toBe('First')
    expect(error).toMatchObject({ message: 'AMA_ERROR:provider_response' })
    expect(parts.some((part) => part.type === 'finish')).toBe(false)
  })

  it('fails an unterminated provider stream even if the JSON itself is complete', async () => {
    const chunks = textChunks(['{"answer":"Incomplete transport"}']).slice(0, -1)
    const model = new MockLanguageModelV3({ doStream: async () => streamResult(chunks) })
    const { stream } = await wrapped(model).doStream(request)
    const { parts, error } = await collectFailure(stream)
    expect(textOf(parts)).toBe('Incomplete transport')
    expect(error).toMatchObject({ message: 'AMA_ERROR:provider_response' })
    expect(parts.some((part) => part.type === 'finish' || part.type === 'text-end')).toBe(false)
  })

  it('preserves unexpected tool activity and its finish reason for SDK rejection and scoring', async () => {
    const toolCall = {
      type: 'tool-call' as const,
      toolCallId: 'unexpected-call',
      toolName: 'searchPersonalContext',
      input: '{"query":"repeat"}',
    }
    const toolFinish = {
      ...finish,
      finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    }
    const chunks: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: toolCall.toolCallId, toolName: toolCall.toolName },
      { type: 'tool-input-delta', id: toolCall.toolCallId, delta: toolCall.input },
      { type: 'tool-input-end', id: toolCall.toolCallId },
      toolCall,
      toolFinish,
    ]
    const generateResult = {
      ...generated(''),
      content: [toolCall],
      finishReason: toolFinish.finishReason,
    }
    const model = new MockLanguageModelV3({
      doGenerate: async () => generateResult,
      doStream: async () => streamResult(chunks),
    })
    expect(await wrapped(model).doGenerate(request)).toBe(generateResult)
    const { stream } = await wrapped(model).doStream(request)
    expect(await convertReadableStreamToArray(stream)).toEqual(chunks)
    expect(model.doStreamCalls[0].toolChoice).toEqual({ type: 'none' })
  })

  it('preserves explicit provider errors without replacing their category or fabricating text', async () => {
    const providerError = new Error('synthetic transport failure')
    const chunks: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'error', error: providerError },
      { ...finish, finishReason: { unified: 'error', raw: 'provider-error' } },
    ]
    const model = new MockLanguageModelV3({ doStream: async () => streamResult(chunks) })
    const { stream } = await wrapped(model).doStream(request)
    expect(await convertReadableStreamToArray(stream)).toEqual(chunks)
  })

  it('propagates stream cancellation and abort signals to the provider', async () => {
    const cancel = vi.fn()
    const abortController = new AbortController()
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 'answer' })
            controller.enqueue({ type: 'text-delta', id: 'answer', delta: '{"answer":"Partial' })
          },
          cancel,
        }),
      }),
    })
    const { stream } = await wrapped(model).doStream({
      ...request,
      abortSignal: abortController.signal,
    })
    const reader = stream.getReader()
    expect((await reader.read()).value).toEqual({ type: 'text-start', id: 'answer' })
    await reader.cancel('user stopped')
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('user stopped'))
    expect(model.doStreamCalls[0].abortSignal).toBe(abortController.signal)
    expect(model.doStreamCalls).toHaveLength(1)
  })

  it('lets the existing reliability wrapper retry a raw empty completion before decoding', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let generateCalls = 0
    let streamCalls = 0
    const rawJson = '{"answer":"Recovered answer"}'
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        ++generateCalls === 1 ? { ...generated(''), content: [] } : generated(rawJson),
      doStream: async () => streamResult(++streamCalls === 1 ? [finish] : textChunks([rawJson])),
    })
    const answerModel = withAmaStructuredAnswer(withAmaInferenceReliability(model)) as Model
    const generation = await answerModel.doGenerate(request)
    expect(generation.content[0]).toMatchObject({ type: 'text', text: 'Recovered answer' })
    const { stream } = await answerModel.doStream(request)
    const parts = await convertReadableStreamToArray(stream)
    expect(textOf(parts)).toBe('Recovered answer')
    expect(parts.filter((part) => part.type === 'text-start')).toHaveLength(1)
    expect(model.doGenerateCalls).toHaveLength(2)
    expect(model.doStreamCalls).toHaveLength(2)
    expect(model.doStreamCalls.every((call) => call.responseFormat?.type === 'json')).toBe(true)
  })

  it('keeps decoder and audit state isolated between concurrent requests', async () => {
    let calls = 0
    const model = new MockLanguageModelV3({
      doStream: async () =>
        streamResult(textChunks(JSON.stringify({ answer: `Answer ${++calls}` }).split(''))),
    })
    const answerModel = wrapped(model)
    const outputs = await Promise.all(
      [1, 2].map(async () => {
        const { stream } = await answerModel.doStream(request)
        return convertReadableStreamToArray(stream)
      }),
    )
    expect(outputs.map(textOf)).toEqual(['Answer 1', 'Answer 2'])
    for (const [index, parts] of outputs.entries()) {
      expect(parts.find((part) => part.type === 'text-end')).toMatchObject({
        providerMetadata: {
          amaStructuredAnswer: { rawJson: JSON.stringify({ answer: `Answer ${index + 1}` }) },
        },
      })
    }
  })
})
