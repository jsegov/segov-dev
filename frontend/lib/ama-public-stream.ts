import {
  createUIMessageStreamResponse,
  parseJsonEventStream,
  uiMessageChunkSchema,
  type UIMessageChunk,
} from 'ai'
import { AMA_STREAM_ERROR_KINDS, createAmaErrorTokenForKind } from './ama-stream-diagnostics'

const publicErrorTokens = new Set<string>(AMA_STREAM_ERROR_KINDS.map(createAmaErrorTokenForKind))
const protocolError = (): UIMessageChunk => ({
  type: 'error',
  errorText: createAmaErrorTokenForKind('ui_stream_protocol'),
})

/** Project validated SDK events; loose SDK schemas may retain additional private fields. */
export function projectAmaPublicChunk(chunk: UIMessageChunk): UIMessageChunk | null {
  switch (chunk.type) {
    case 'start':
      return {
        type: chunk.type,
        ...(chunk.messageId === undefined ? {} : { messageId: chunk.messageId }),
      }
    case 'start-step':
    case 'finish-step':
    case 'abort':
      return { type: chunk.type }
    case 'text-start':
    case 'text-end':
      return { type: chunk.type, id: chunk.id }
    case 'text-delta':
      return { type: chunk.type, id: chunk.id, delta: chunk.delta }
    case 'finish':
      return {
        type: chunk.type,
        ...(chunk.finishReason === undefined ? {} : { finishReason: chunk.finishReason }),
      }
    case 'error':
      return {
        type: 'error',
        errorText: publicErrorTokens.has(chunk.errorText)
          ? chunk.errorText
          : createAmaErrorTokenForKind('unknown'),
      }
    default:
      return null
  }
}

/**
 * Apply only to the response branch AFTER createAgentUIStreamResponse. Filtering
 * inside agent.stream would also remove tool results from model steps and traces.
 */
export function createAmaPublicStreamResponse(response: Response): Response {
  const reader = response.body
    ? parseJsonEventStream({ stream: response.body, schema: uiMessageChunkSchema }).getReader()
    : undefined
  let terminalSeen = false
  let cancelled = false
  const stream = new ReadableStream<UIMessageChunk>(
    {
      async pull(controller) {
        try {
          while (!cancelled) {
            const result = await reader?.read()
            if (cancelled) {
              return
            }
            if (!result || result.done) {
              if (!terminalSeen) {
                controller.enqueue(protocolError())
              }
              controller.close()
              return
            }
            if (!result.value.success) {
              controller.enqueue(protocolError())
              controller.close()
              void reader?.cancel().catch(() => undefined)
              return
            }
            const chunk = projectAmaPublicChunk(result.value.value)
            if (!chunk) {
              continue
            }
            if (chunk.type === 'finish' || chunk.type === 'abort' || chunk.type === 'error') {
              terminalSeen = true
            }
            controller.enqueue(chunk)
            return
          }
        } catch {
          if (!cancelled) {
            controller.enqueue(protocolError())
            controller.close()
          }
        }
      },
      cancel(reason) {
        cancelled = true
        return reader?.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
  const headers = new Headers(response.headers)
  headers.delete('Content-Length')
  headers.delete('Content-Encoding')
  headers.set('Cache-Control', 'no-store')
  return createUIMessageStreamResponse({
    stream,
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
