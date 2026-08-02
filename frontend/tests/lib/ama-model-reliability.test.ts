import { wrapLanguageModel } from 'ai'
import { MockLanguageModelV3, convertReadableStreamToArray, simulateReadableStream } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAmaEmptyCompletionRetryMiddleware } from '@/lib/ama-model-reliability'

type StreamResult = Awaited<ReturnType<MockLanguageModelV3['doStream']>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never
type GenerateResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 1,
    text: 1,
    reasoning: 0,
  },
}

function streamResult(chunks: StreamPart[]): StreamResult {
  return {
    stream: simulateReadableStream({ chunks, chunkDelayInMs: null }),
  }
}

function emptyStreamResult(): StreamResult {
  return streamResult([
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'empty-response' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
    },
  ])
}

function textStreamResult(text: string): StreamResult {
  return streamResult([
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'text-response' },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
    },
  ])
}

function emptyGenerateResult(): GenerateResult {
  return {
    content: [],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  }
}

function textGenerateResult(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  }
}

describe('AMA empty completion retry middleware', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retries an empty successful stream before exposing provider chunks', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let callCount = 0
    const model = new MockLanguageModelV3({
      provider: 'inference',
      modelId: 'ama',
      doStream: async () => {
        callCount += 1
        return callCount === 1 ? emptyStreamResult() : textStreamResult('Recovered answer')
      },
    })
    const wrapped = wrapLanguageModel({
      model,
      middleware: createAmaEmptyCompletionRetryMiddleware(),
    })

    const result = await wrapped.doStream({ prompt: [] })
    const parts = await convertReadableStreamToArray(result.stream)

    expect(callCount).toBe(2)
    expect(parts).toContainEqual({ type: 'text-delta', id: 'text-1', delta: 'Recovered answer' })
    expect(parts).not.toContainEqual(
      expect.objectContaining({ type: 'response-metadata', id: 'empty-response' }),
    )
  })

  it('emits an error instead of completing with a blank turn after retry exhaustion', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const model = new MockLanguageModelV3({
      provider: 'inference',
      modelId: 'ama',
      doStream: async () => emptyStreamResult(),
    })
    const wrapped = wrapLanguageModel({
      model,
      middleware: createAmaEmptyCompletionRetryMiddleware(),
    })

    const result = await wrapped.doStream({ prompt: [] })
    const parts = await convertReadableStreamToArray(result.stream)

    expect(model.doStreamCalls).toHaveLength(2)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      type: 'error',
      error: expect.objectContaining({ name: 'AI_NoOutputGeneratedError' }),
    })
  })

  it('also retries non-streaming agent generations used by evals', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let callCount = 0
    const model = new MockLanguageModelV3({
      provider: 'inference',
      modelId: 'ama',
      doGenerate: async () => {
        callCount += 1
        return callCount === 1 ? emptyGenerateResult() : textGenerateResult('Recovered answer')
      },
    })
    const wrapped = wrapLanguageModel({
      model,
      middleware: createAmaEmptyCompletionRetryMiddleware(),
    })

    const result = await wrapped.doGenerate({ prompt: [] })

    expect(callCount).toBe(2)
    expect(result.content).toEqual([{ type: 'text', text: 'Recovered answer' }])
  })
})
