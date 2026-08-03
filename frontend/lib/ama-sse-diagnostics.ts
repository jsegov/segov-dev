export const AMA_TRACE_ID_HEADER = 'X-Ama-Trace-Id'

const AMA_SSE_EVENT_TYPES = [
  'start',
  'start-step',
  'text-start',
  'text-delta',
  'text-end',
  'reasoning-start',
  'reasoning-delta',
  'reasoning-end',
  'tool-input-start',
  'tool-input-delta',
  'tool-input-available',
  'tool-input-error',
  'tool-output-available',
  'tool-output-error',
  'finish-step',
  'finish',
  'abort',
  'error',
] as const

const AMA_FINISH_REASONS = new Set([
  'stop',
  'length',
  'content-filter',
  'tool-calls',
  'error',
  'other',
  'unknown',
])

type AmaSseEventType = (typeof AMA_SSE_EVENT_TYPES)[number]

export interface AmaSseWireSummary {
  byteLength: number
  eventCount: number
  eventCounts: Record<AmaSseEventType, number>
  unknownEventCount: number
  invalidJsonCount: number
  textDeltaLength: number
  finishReason?: string
  sawDone: boolean
  truncatedFrame: boolean
}

export interface AmaSseWireObservation {
  traceId?: string
  summary: AmaSseWireSummary
}

export interface AmaSseResponseObserver {
  onComplete?: (observation: AmaSseWireObservation) => void
  onError?: (error: unknown, observation: AmaSseWireObservation) => void
  onCancel?: (observation: AmaSseWireObservation) => void
}

const EVENT_TYPE_SET = new Set<string>(AMA_SSE_EVENT_TYPES)

function createEventCounts(): Record<AmaSseEventType, number> {
  return Object.fromEntries(AMA_SSE_EVENT_TYPES.map((type) => [type, 0])) as Record<
    AmaSseEventType,
    number
  >
}

function getSafeTraceId(response: Response): string | undefined {
  const traceId = response.headers.get(AMA_TRACE_ID_HEADER)
  return traceId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(traceId)
    ? traceId
    : undefined
}

function notifySafely(callback: (() => void) | undefined) {
  try {
    callback?.()
  } catch {
    // Diagnostics must never interrupt the chat stream.
  }
}

/**
 * Incrementally summarizes AI SDK SSE frames without retaining event payloads.
 */
export function createAmaSseWireCollector() {
  const encoder = new TextEncoder()
  const eventCounts = createEventCounts()
  let buffer = ''
  let byteLength = 0
  let eventCount = 0
  let unknownEventCount = 0
  let invalidJsonCount = 0
  let textDeltaLength = 0
  let finishReason: string | undefined
  let sawDone = false
  let finishedSummary: AmaSseWireSummary | undefined

  function consumeFrame(frame: string) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')

    if (!data) {
      return
    }

    if (data === '[DONE]') {
      sawDone = true
      return
    }

    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      invalidJsonCount += 1
      return
    }

    eventCount += 1
    if (typeof event !== 'object' || event === null) {
      unknownEventCount += 1
      return
    }

    const eventRecord = event as Record<string, unknown>
    const type = eventRecord.type
    if (typeof type !== 'string' || !EVENT_TYPE_SET.has(type)) {
      unknownEventCount += 1
      return
    }

    eventCounts[type as AmaSseEventType] += 1
    if (type === 'text-delta' && typeof eventRecord.delta === 'string') {
      textDeltaLength += eventRecord.delta.length
    }
    if (type === 'finish' && typeof eventRecord.finishReason === 'string') {
      finishReason = AMA_FINISH_REASONS.has(eventRecord.finishReason)
        ? eventRecord.finishReason
        : 'unknown'
    }
  }

  function drainFrames() {
    while (true) {
      const separator = buffer.match(/\r?\n\r?\n/)
      if (!separator || separator.index === undefined) {
        return
      }

      const frame = buffer.slice(0, separator.index)
      buffer = buffer.slice(separator.index + separator[0].length)
      consumeFrame(frame)
    }
  }

  function summarize(truncatedFrame: boolean): AmaSseWireSummary {
    return {
      byteLength,
      eventCount,
      eventCounts: { ...eventCounts },
      unknownEventCount,
      invalidJsonCount,
      textDeltaLength,
      ...(finishReason ? { finishReason } : {}),
      sawDone,
      truncatedFrame,
    }
  }

  return {
    push(chunk: string, chunkByteLength = encoder.encode(chunk).byteLength) {
      if (finishedSummary) {
        return
      }

      byteLength += chunkByteLength
      buffer += chunk
      drainFrames()
    },
    finish(): AmaSseWireSummary {
      if (!finishedSummary) {
        finishedSummary = summarize(buffer.trim().length > 0)
        buffer = ''
      }

      return finishedSummary
    },
  }
}

/**
 * Observes the browser's exact response body while forwarding every byte with
 * the original stream's backpressure and error behavior.
 */
export function observeAmaSseResponse(
  response: Response,
  observer: AmaSseResponseObserver,
): Response {
  if (!response.ok || !response.body) {
    return response
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const collector = createAmaSseWireCollector()
  const traceId = getSafeTraceId(response)
  let settled = false

  function finishObservation(): AmaSseWireObservation {
    if (!settled) {
      collector.push(decoder.decode(), 0)
      settled = true
    }

    return { ...(traceId ? { traceId } : {}), summary: collector.finish() }
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          const observation = finishObservation()
          notifySafely(() => observer.onComplete?.(observation))
          controller.close()
          return
        }

        collector.push(decoder.decode(value, { stream: true }), value.byteLength)
        controller.enqueue(value)
      } catch (error) {
        const observation = finishObservation()
        notifySafely(() => observer.onError?.(error, observation))
        controller.error(error)
      }
    },
    async cancel(reason) {
      const observation = finishObservation()
      notifySafely(() => observer.onCancel?.(observation))
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
