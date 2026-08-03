import { consumeStream, createAgentUIStreamResponse } from 'ai'
import { randomUUID } from 'node:crypto'
import { after } from 'next/server'
import { createAmaAgent, getAmaCallSettings } from '@/lib/ama-agent'
import { getAmaModelConfig } from '@/lib/ama-model-config'
import { AMA_TRACE_ID_HEADER, createAmaSseWireCollector } from '@/lib/ama-sse-diagnostics'
import {
  AMA_ERROR_KIND_HEADER,
  createAmaErrorTokenForKind,
  createAmaPublicErrorToken,
  getAmaStreamErrorDetails,
  summarizeAmaUiMessage,
  type AmaStreamErrorKind,
} from '@/lib/ama-stream-diagnostics'
import { createAmaTraceCollector, persistAmaTrace, type AmaRequestTrigger } from '@/lib/ama-traces'
import { waitForAmaInferenceEndpoint } from '@/lib/ama-wake'

export const runtime = 'nodejs'
export const maxDuration = 300

// Leave enough headroom for the AI SDK to emit a classified stream error
// before Vercel's Fluid Compute invocation limit terminates the function.
const AMA_REQUEST_BUDGET_MS = 285_000
const AMA_INFERENCE_STARTUP_TIMEOUT_MS = 135_000

function createInferenceStartupTimeoutError(): Error {
  const error = new Error('The inference endpoint did not become ready in time.')
  error.name = 'TimeoutError'
  return error
}

function createErrorResponse(kind: AmaStreamErrorKind, status: number): Response {
  return new Response(createAmaErrorTokenForKind(kind), {
    status,
    headers: {
      [AMA_ERROR_KIND_HEADER]: kind,
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
}

function getHttpStatusForError(kind: AmaStreamErrorKind): number {
  switch (kind) {
    case 'invalid_request':
      return 400
    case 'rate_limit':
      return 429
    case 'timeout':
      return 504
    case 'provider_unavailable':
      return 503
    case 'network':
    case 'provider_response':
    case 'empty_response':
    case 'ui_stream_protocol':
      return 502
    default:
      return 500
  }
}

function getRequestTrigger(value: unknown): AmaRequestTrigger | null {
  if (value === undefined) {
    return 'submit-message'
  }

  return value === 'submit-message' || value === 'regenerate-message' ? value : null
}

function getFirstUserMessageId(messages: unknown[]): string | null {
  for (const message of messages) {
    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { role?: unknown }).role === 'user'
    ) {
      const id = (message as { id?: unknown }).id
      if (typeof id === 'string' && id.trim()) {
        return id
      }
    }
  }

  return null
}

export async function POST(req: Request) {
  const requestStartedAt = Date.now()
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return createErrorResponse('invalid_request', 400)
  }

  const requestBody = body as { id?: unknown; messages?: unknown; trigger?: unknown }
  const messages = requestBody.messages
  if (!Array.isArray(messages)) {
    return createErrorResponse('invalid_request', 400)
  }

  const requestTrigger = getRequestTrigger(requestBody.trigger)
  if (!requestTrigger) {
    return createErrorResponse('invalid_request', 400)
  }

  const traceId = randomUUID()
  let traceCollector: ReturnType<typeof createAmaTraceCollector> | undefined

  try {
    const modelConfig = getAmaModelConfig()
    const activeTraceCollector = createAmaTraceCollector({
      traceId,
      conversationId:
        getFirstUserMessageId(messages) ??
        (typeof requestBody.id === 'string' && requestBody.id.trim() ? requestBody.id : traceId),
      requestTrigger,
      deploymentEnvironment: process.env.VERCEL_ENV ?? 'development',
      model: modelConfig.model,
      callSettings: getAmaCallSettings(modelConfig),
    })
    traceCollector = activeTraceCollector

    let agentTimeoutMs = AMA_REQUEST_BUDGET_MS
    if (modelConfig.inference) {
      const readiness = await waitForAmaInferenceEndpoint({
        timeoutMs: AMA_INFERENCE_STARTUP_TIMEOUT_MS,
        signal: req.signal,
      })
      console.info(
        JSON.stringify({
          event: 'ama_inference_readiness',
          traceId,
          readiness,
        }),
      )

      if (readiness === 'timed_out') {
        throw createInferenceStartupTimeoutError()
      }

      // Startup polling and generation share the function's 285s safety
      // budget, preserving 15s for classified errors before Vercel's 300s
      // invocation limit.
      agentTimeoutMs = Math.max(1_000, AMA_REQUEST_BUDGET_MS - (Date.now() - requestStartedAt))
    }

    const agent = createAmaAgent({
      modelConfig,
      prepareCall: activeTraceCollector.prepareCall,
      onFinish: activeTraceCollector.onFinish,
    })
    const streamOptions = {
      agent,
      uiMessages: messages,
      abortSignal: req.signal,
      timeout: { totalMs: agentTimeoutMs },
      onFinish: ({
        responseMessage,
        finishReason,
        isAborted,
        isContinuation,
      }: {
        responseMessage: Parameters<typeof summarizeAmaUiMessage>[0]
        finishReason?: string
        isAborted: boolean
        isContinuation: boolean
      }) => {
        console.info(
          JSON.stringify({
            event: 'ama_ui_stream_finish',
            traceId,
            finishReason,
            isAborted,
            isContinuation,
            responseMessage: summarizeAmaUiMessage(responseMessage),
          }),
        )
      },
      onError: (error: unknown) => {
        const errorDetails = getAmaStreamErrorDetails(error, 'server_stream')
        console.error(
          JSON.stringify({
            event: 'ama_ui_stream_error',
            traceId,
            ...errorDetails,
          }),
        )
        return createAmaPublicErrorToken(error, 'server_stream')
      },
      consumeSseStream: async ({ stream }: { stream: ReadableStream<string> }) => {
        const collector = createAmaSseWireCollector()
        let outcome: 'complete' | 'error' = 'complete'
        try {
          await consumeStream({
            stream: stream.pipeThrough(
              new TransformStream<string, string>({
                transform(chunk, controller) {
                  collector.push(chunk)
                  controller.enqueue(chunk)
                },
              }),
            ),
            onError: (error) => {
              outcome = 'error'
              console.error(
                JSON.stringify({
                  event: 'ama_sse_consumer_error',
                  traceId,
                  ...getAmaStreamErrorDetails(error, 'server_stream'),
                }),
              )
            },
          })
        } finally {
          console.info(
            JSON.stringify({
              event: 'ama_sse_wire_finish',
              traceId,
              outcome,
              summary: collector.finish(),
            }),
          )
          activeTraceCollector.settleWithoutTrace()
        }
      },
    }
    const response = await createAgentUIStreamResponse(streamOptions)
    response.headers.set(AMA_TRACE_ID_HEADER, traceId)

    after(async () => {
      const trace = await activeTraceCollector.payload
      if (trace) {
        await persistAmaTrace(trace)
      }
    })

    return response
  } catch (error) {
    traceCollector?.settleWithoutTrace()
    const errorDetails = getAmaStreamErrorDetails(error, 'request')
    console.error(
      JSON.stringify({
        event: 'ama_chat_route_error',
        traceId,
        ...errorDetails,
      }),
    )
    return createErrorResponse(
      errorDetails.errorKind,
      getHttpStatusForError(errorDetails.errorKind),
    )
  }
}
