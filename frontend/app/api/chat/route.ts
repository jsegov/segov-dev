import { consumeStream, createAgentUIStreamResponse } from 'ai'
import { randomUUID } from 'node:crypto'
import { after } from 'next/server'
import { createAmaAgent, getAmaCallSettings } from '@/lib/ama-agent'
import { getAmaModelConfig } from '@/lib/ama-model-config'
import {
  AMA_ERROR_KIND_HEADER,
  createAmaErrorTokenForKind,
  createAmaPublicErrorToken,
  getAmaStreamErrorDetails,
  summarizeAmaUiMessage,
  type AmaStreamErrorKind,
} from '@/lib/ama-stream-diagnostics'
import { createAmaTraceCollector, persistAmaTrace, type AmaRequestTrigger } from '@/lib/ama-traces'

export const runtime = 'nodejs'
export const maxDuration = 300

// Leave enough headroom for the AI SDK to emit a classified stream error
// before Vercel's Fluid Compute invocation limit terminates the function.
const AMA_AGENT_TIMEOUT_MS = 285_000

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
    const agent = createAmaAgent({
      modelConfig,
      prepareCall: activeTraceCollector.prepareCall,
      onFinish: activeTraceCollector.onFinish,
    })
    const streamOptions = {
      agent,
      uiMessages: messages,
      abortSignal: req.signal,
      timeout: { totalMs: AMA_AGENT_TIMEOUT_MS },
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
        try {
          await consumeStream({
            stream,
            onError: (error) => {
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
          activeTraceCollector.settleWithoutTrace()
        }
      },
    }
    const response = await createAgentUIStreamResponse(streamOptions)

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
    return createErrorResponse(errorDetails.errorKind, getHttpStatusForError(errorDetails.errorKind))
  }
}
