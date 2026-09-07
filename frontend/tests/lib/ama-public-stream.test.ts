// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createAmaPublicStreamResponse } from '@/lib/ama-public-stream'

const secret = 'PRIVATE_CANARY_雪'
function source(events: unknown[], ending = 'data: [DONE]\n\n', chunkSize = 1) {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + ending,
  )
  let offset = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) {
          return controller.close()
        }
        controller.enqueue(bytes.slice(offset, offset + chunkSize))
        offset = Math.min(bytes.length, offset + chunkSize)
      },
    }),
    { headers: { 'X-Ama-Trace-Id': 'trace', 'Content-Length': String(bytes.length) } },
  )
}
function events(wire: string) {
  return wire
    .split('\n\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)))
}

describe('AMA public stream boundary', () => {
  it.each([1, 8192])(
    'removes private events and extra fields with %i-byte frames',
    async (size) => {
      const response = createAmaPublicStreamResponse(
        source(
          [
            { type: 'start', messageId: 'assistant', messageMetadata: secret },
            { type: 'start-step', private: secret },
            { type: 'tool-input-start', toolCallId: secret, toolName: secret },
            { type: 'tool-input-delta', toolCallId: secret, inputTextDelta: secret },
            { type: 'tool-input-available', toolCallId: secret, toolName: secret, input: secret },
            { type: 'tool-output-available', toolCallId: secret, output: secret },
            { type: 'tool-output-error', toolCallId: secret, errorText: secret },
            { type: 'tool-approval-request', approvalId: secret, toolCallId: secret },
            { type: 'reasoning-start', id: secret },
            { type: 'reasoning-delta', id: secret, delta: secret },
            { type: 'reasoning-end', id: secret },
            { type: 'source-url', sourceId: secret, url: secret },
            { type: 'file', url: secret, mediaType: secret },
            { type: 'data-private', data: secret },
            { type: 'message-metadata', messageMetadata: secret },
            { type: 'text-start', id: 'text', providerMetadata: { private: { secret } } },
            { type: 'text-delta', id: 'text', delta: 'Public café 雪', extra: secret },
            { type: 'text-end', id: 'text', extra: secret },
            { type: 'finish-step', extra: secret },
            { type: 'finish', finishReason: 'stop', messageMetadata: secret },
          ],
          undefined,
          size,
        ),
      )
      const wire = await response.text()
      expect(wire).not.toContain(secret)
      expect(events(wire)).toEqual([
        { type: 'start', messageId: 'assistant' },
        { type: 'start-step' },
        { type: 'text-start', id: 'text' },
        { type: 'text-delta', id: 'text', delta: 'Public café 雪' },
        { type: 'text-end', id: 'text' },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ])
      expect(wire.match(/\[DONE\]/g)).toHaveLength(1)
      expect(response.headers.get('X-Ama-Trace-Id')).toBe('trace')
      expect(response.headers.get('Content-Length')).toBeNull()
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    },
  )

  it.each(['AMA_ERROR:timeout', secret, `AMA_ERROR:timeout ${secret}`])(
    'allows only complete canonical error tokens',
    async (errorText) => {
      const wire = await createAmaPublicStreamResponse(
        source([{ type: 'error', errorText }]),
      ).text()
      expect(events(wire)).toEqual([
        {
          type: 'error',
          errorText: errorText === 'AMA_ERROR:timeout' ? errorText : 'AMA_ERROR:unknown',
        },
      ])
      expect(wire).not.toContain(secret)
    },
  )

  it('strips an abort reason without manufacturing success or another error', async () => {
    const wire = await createAmaPublicStreamResponse(
      source([{ type: 'abort', reason: secret }]),
    ).text()
    expect(events(wire)).toEqual([{ type: 'abort' }])
  })

  it.each([
    source([{ type: 'unknown-private-event', secret }]),
    source([{ type: 'text-delta', id: 'text', delta: 123, secret }]),
    source([], `data: {\"private\":\"${secret}\"\n\n`),
    source([{ type: 'start' }], ''),
    source([], ''),
    new Response(null),
  ])('fails closed on invalid or incomplete streams', async (input) => {
    const wire = await createAmaPublicStreamResponse(input).text()
    expect(events(wire).at(-1)).toEqual({
      type: 'error',
      errorText: 'AMA_ERROR:ui_stream_protocol',
    })
    expect(wire).not.toContain(secret)
    expect(events(wire).some((event) => event.type === 'finish')).toBe(false)
  })

  it('propagates cancellation during a pending read', async () => {
    const cancel = vi.fn()
    const response = createAmaPublicStreamResponse(
      new Response(new ReadableStream<Uint8Array>({ cancel })),
    )
    const reader = response.body!.getReader()
    const pending = reader.read()
    await reader.cancel()
    expect(await pending).toEqual({ done: true, value: undefined })
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  })
})
