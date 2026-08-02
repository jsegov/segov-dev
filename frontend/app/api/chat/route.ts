import { consumeStream, createAgentUIStreamResponse } from 'ai'
import { randomUUID } from 'node:crypto'
import { after } from 'next/server'
import { createAmaAgent, getAmaCallSettings } from '@/lib/ama-agent'
import { getAmaModelConfig } from '@/lib/ama-model-config'
import { getAmaStreamErrorType, summarizeAmaUiMessage } from '@/lib/ama-stream-diagnostics'
import { createAmaTraceCollector, persistAmaTrace, type AmaRequestTrigger } from '@/lib/ama-traces'

export const runtime = 'nodejs'

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
    return new Response('Invalid request payload.', { status: 400 })
  }

  const requestBody = body as { id?: unknown; messages?: unknown; trigger?: unknown }
  const messages = requestBody.messages
  if (!Array.isArray(messages)) {
    return new Response('Invalid request payload: expected messages array.', { status: 400 })
  }

  const requestTrigger = getRequestTrigger(requestBody.trigger)
  if (!requestTrigger) {
    return new Response('Invalid request payload: unexpected trigger.', { status: 400 })
  }

  const modelConfig = getAmaModelConfig()
  const traceId = randomUUID()
  const traceCollector = createAmaTraceCollector({
    traceId,
    conversationId:
      getFirstUserMessageId(messages) ??
      (typeof requestBody.id === 'string' && requestBody.id.trim() ? requestBody.id : traceId),
    requestTrigger,
    deploymentEnvironment: process.env.VERCEL_ENV ?? 'development',
    model: modelConfig.model,
    callSettings: getAmaCallSettings(modelConfig),
  })
  const agent = createAmaAgent({
    modelConfig,
    prepareCall: traceCollector.prepareCall,
    onFinish: traceCollector.onFinish,
  })

  try {
    const streamOptions = {
      agent,
      uiMessages: messages,
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
        console.error(
          JSON.stringify({
            event: 'ama_ui_stream_error',
            traceId,
            errorType: getAmaStreamErrorType(error),
          }),
        )
        return 'An error occurred.'
      },
      consumeSseStream: async ({ stream }: { stream: ReadableStream<string> }) => {
        try {
          await consumeStream({
            stream,
            onError: () => undefined,
          })
        } finally {
          traceCollector.settleWithoutTrace()
        }
      },
    }
    const response = await createAgentUIStreamResponse(streamOptions)

    after(async () => {
      const trace = await traceCollector.payload
      if (trace) {
        await persistAmaTrace(trace)
      }
    })

    return response
  } catch (error) {
    traceCollector.settleWithoutTrace()
    console.error(
      JSON.stringify({
        event: 'ama_chat_route_error',
        traceId,
        errorType: getAmaStreamErrorType(error),
      }),
    )
    return new Response('Chat service unavailable.', { status: 500 })
  }
}
