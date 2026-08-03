import { describe, expect, it, vi } from 'vitest'
import {
  AMA_TRACE_ID_HEADER,
  createAmaSseWireCollector,
  observeAmaSseResponse,
} from '@/lib/ama-sse-diagnostics'
import {
  createAmaPublicErrorToken,
  getAmaErrorPresentation,
  getAmaStreamErrorDetails,
  getAmaStreamErrorType,
  sanitizeAmaChatHttpResponse,
  summarizeAmaUiMessage,
} from '@/lib/ama-stream-diagnostics'

describe('AMA stream diagnostics', () => {
  it('reports message shape and lengths without exposing text or tool output', () => {
    const summary = summarizeAmaUiMessage({
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        { type: 'text', text: ' private answer ' },
        {
          type: 'dynamic-tool',
          toolName: 'search_personal_context',
          toolCallId: 'tool-1',
          state: 'output-available',
          input: { query: 'private query' },
          output: { content: 'private context' },
        },
      ],
    })

    expect(summary).toEqual({
      id: 'assistant-1',
      role: 'assistant',
      partTypes: ['text', 'dynamic-tool'],
      textLength: 16,
      trimmedTextLength: 14,
    })
    expect(JSON.stringify(summary)).not.toContain('private')
  })

  it('reduces errors to their type', () => {
    expect(getAmaStreamErrorType(new TypeError('secret details'))).toBe('TypeError')
    expect(getAmaStreamErrorType('secret details')).toBe('string')
  })

  it('classifies nested retryable provider errors without exposing their payload', () => {
    const providerError = Object.assign(new Error('private provider response'), {
      name: 'AI_APICallError',
      statusCode: 503,
      isRetryable: true,
      responseBody: 'private response body',
    })
    const retryError = Object.assign(new Error('private retry history'), {
      name: 'AI_RetryError',
      reason: 'maxRetriesExceeded',
      lastError: providerError,
    })

    const details = getAmaStreamErrorDetails(retryError)

    expect(details).toEqual({
      errorType: 'AI_RetryError',
      errorKind: 'provider_unavailable',
      retryable: true,
      statusCode: 503,
    })
    expect(JSON.stringify(details)).not.toContain('private')
    expect(createAmaPublicErrorToken(retryError)).toBe('AMA_ERROR:provider_unavailable')
  })

  it.each([
    ['TimeoutError', 'timeout', true],
    ['AbortError', 'aborted', false],
    ['AI_UIMessageStreamError', 'ui_stream_protocol', true],
    ['AI_NoOutputGeneratedError', 'empty_response', true],
    ['AI_InvalidToolInputError', 'invalid_tool_call', true],
    ['AI_TypeValidationError', 'invalid_request', false],
    ['AI_LoadAPIKeyError', 'configuration', false],
    ['AI_JSONParseError', 'provider_response', true],
  ] as const)('classifies %s as %s', (name, errorKind, retryable) => {
    const error = Object.assign(new Error('private details'), { name })

    expect(getAmaStreamErrorDetails(error)).toEqual({
      errorType: name,
      errorKind,
      retryable,
    })
  })

  it('recovers a safe server error category from the public token', () => {
    const error = new Error('AMA_ERROR:rate_limit')

    expect(getAmaStreamErrorDetails(error)).toEqual({
      errorType: 'Error',
      errorKind: 'rate_limit',
      retryable: true,
    })
    expect(getAmaErrorPresentation(error)).toEqual({
      title: 'Model temporarily unavailable',
      description: 'The model is temporarily unavailable. Please retry in a moment.',
    })
  })

  it('treats browser fetch failures as retryable disconnects', () => {
    expect(getAmaStreamErrorDetails(new TypeError('Failed to fetch'))).toEqual({
      errorType: 'TypeError',
      errorKind: 'network',
      retryable: true,
    })
  })

  it('distinguishes invalid request history from a malformed client stream chunk', () => {
    const error = Object.assign(new Error('private schema value'), {
      name: 'AI_TypeValidationError',
    })

    expect(getAmaStreamErrorDetails(error, 'request').errorKind).toBe('invalid_request')
    expect(getAmaStreamErrorDetails(error, 'client_stream').errorKind).toBe('ui_stream_protocol')
    expect(getAmaStreamErrorDetails(error, 'server_stream').errorKind).toBe('provider_response')
  })

  it.each([
    [400, 'invalid_request'],
    [401, 'authentication'],
    [404, 'configuration'],
    [429, 'rate_limit'],
    [503, 'provider_unavailable'],
    [504, 'timeout'],
  ] as const)('sanitizes an HTTP %s response as %s', async (status, errorKind) => {
    const response = sanitizeAmaChatHttpResponse(
      new Response('private proxy or platform error page', { status }),
    )

    expect(response.status).toBe(status)
    expect(await response.text()).toBe(`AMA_ERROR:${errorKind}`)
  })

  it('preserves the route-provided safe kind over a generic HTTP status', async () => {
    const response = sanitizeAmaChatHttpResponse(
      new Response('private server error', {
        status: 500,
        headers: { 'X-Ama-Error-Kind': 'configuration' },
      }),
    )

    expect(await response.text()).toBe('AMA_ERROR:configuration')
  })

  it('summarizes fragmented SSE frames without retaining their payloads', () => {
    const privateDelta = 'private response text'
    const wire = [
      'data: {"type":"start"}\n\n',
      `data: {"type":"text-delta","id":"text-1","delta":"${privateDelta}"}\n\n`,
      'data: {"type":"finish","finishReason":"stop"}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    const collector = createAmaSseWireCollector()

    collector.push(wire.slice(0, 13))
    collector.push(wire.slice(13, 57))
    collector.push(wire.slice(57))

    const summary = collector.finish()
    expect(summary).toMatchObject({
      byteLength: new TextEncoder().encode(wire).byteLength,
      eventCount: 3,
      unknownEventCount: 0,
      invalidJsonCount: 0,
      textDeltaLength: privateDelta.length,
      finishReason: 'stop',
      sawDone: true,
      truncatedFrame: false,
    })
    expect(summary.eventCounts).toMatchObject({
      start: 1,
      'text-delta': 1,
      finish: 1,
      error: 0,
    })
    expect(JSON.stringify(summary)).not.toContain(privateDelta)
    expect(JSON.stringify(summary)).not.toContain('text-1')
  })

  it('reports invalid and incomplete SSE frames without exposing their contents', () => {
    const collector = createAmaSseWireCollector()
    collector.push(
      'data: private invalid json\n\ndata: {"type":"text-delta","delta":"secret tail"}',
    )

    const summary = collector.finish()
    expect(summary).toMatchObject({
      eventCount: 0,
      invalidJsonCount: 1,
      textDeltaLength: 0,
      sawDone: false,
      truncatedFrame: true,
    })
    expect(JSON.stringify(summary)).not.toContain('private')
    expect(JSON.stringify(summary)).not.toContain('secret')
  })

  it('observes the browser stream while preserving its exact bytes and trace ID', async () => {
    const traceId = '5dbcf4b4-438e-4af1-8841-78081b0d07c1'
    const wire = 'data: {"type":"text-delta","id":"text-1","delta":"answer"}\n\ndata: [DONE]\n\n'
    const encoded = new TextEncoder().encode(wire)
    const onComplete = vi.fn()
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded.slice(0, 17))
          controller.enqueue(encoded.slice(17))
          controller.close()
        },
      }),
      { headers: { [AMA_TRACE_ID_HEADER]: traceId } },
    )

    const observed = observeAmaSseResponse(response, { onComplete })

    expect(await observed.text()).toBe(wire)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledWith({
      traceId,
      summary: expect.objectContaining({
        byteLength: encoded.byteLength,
        eventCount: 1,
        textDeltaLength: 6,
        sawDone: true,
        truncatedFrame: false,
      }),
    })
  })

  it('reports a browser body failure with the safely summarized partial stream', async () => {
    const privateError = new TypeError('private browser stream failure')
    const encoded = new TextEncoder().encode('data: {"type":"start"}\n\n')
    const onError = vi.fn()
    let pullCount = 0
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pullCount++ === 0) {
            controller.enqueue(encoded)
            return
          }

          controller.error(privateError)
        },
      }),
    )

    const observed = observeAmaSseResponse(response, { onError })

    await expect(observed.text()).rejects.toThrow()
    expect(onError).toHaveBeenCalledWith(privateError, {
      summary: expect.objectContaining({
        byteLength: encoded.byteLength,
        eventCount: 1,
        sawDone: false,
        truncatedFrame: false,
      }),
    })
    expect(JSON.stringify(onError.mock.calls[0]?.[1])).not.toContain('private')
  })
})
