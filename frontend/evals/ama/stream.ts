import { Chat } from '@ai-sdk/react'
import {
  consumeStream,
  createAgentUIStreamResponse,
  DefaultChatTransport,
  parseJsonEventStream,
  uiMessageChunkSchema,
  type UIMessage,
} from 'ai'
import { createAmaAgent, type CreateAmaAgentOptions } from '@/lib/ama-agent'
import { getAmaModelConfig } from '@/lib/ama-model-config'
import { prepareAmaGeneration } from '@/lib/ama-request-budget'
import { createAmaPublicStreamResponse } from '@/lib/ama-public-stream'
import { getAmaStreamErrorDetails } from '@/lib/ama-stream-diagnostics'
import type { AmaEvalCase, AmaEvalGenerationDiagnostics, AmaEvalToolOutcome } from './types'

interface EvalToolCall {
  toolName?: string
  toolCallId?: string
  invalid?: boolean
}

interface EvalToolResult {
  toolName?: string
  toolCallId?: string
  output?: unknown
}

interface EvalStep {
  finishReason?: string
  usage?: unknown
  toolCalls?: EvalToolCall[]
  toolResults?: EvalToolResult[]
  content?: Array<{ type?: string; toolName?: string; toolCallId?: string }>
}

export interface GenerateResultWithToolCalls extends EvalStep {
  text?: string
  totalUsage?: unknown
  response?: { modelId?: string }
  providerMetadata?: { gateway?: { provider?: unknown } }
  steps?: EvalStep[]
}

function sanitizeUsageMetadata(usage: unknown): Record<string, number> | undefined {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return undefined
  }
  const fields = Object.fromEntries(
    Object.entries(usage).filter(
      ([, value]) => typeof value === 'number' && Number.isFinite(value),
    ),
  ) as Record<string, number>
  const reasoning = (usage as { outputTokenDetails?: { reasoningTokens?: unknown } })
    .outputTokenDetails?.reasoningTokens
  if (typeof reasoning === 'number' && Number.isFinite(reasoning)) {
    fields.reasoningTokens = reasoning
  }
  return Object.keys(fields).length ? fields : undefined
}

export function extractToolCalls(result: GenerateResultWithToolCalls): string[] {
  // result.toolCalls is the last step, already present in steps. Never count it twice or deduplicate repeats.
  return (
    result.steps ? result.steps.flatMap((step) => step.toolCalls ?? []) : (result.toolCalls ?? [])
  ).flatMap((call) => (typeof call.toolName === 'string' ? [call.toolName] : []))
}

const KNOWN_TOOL_NAMES = new Set<string>([
  'get_public_site_content',
  'get_resume',
  'search_work_context',
  'search_personal_context',
])

function isKnownToolName(name: unknown): name is AmaEvalToolOutcome['name'] {
  return typeof name === 'string' && KNOWN_TOOL_NAMES.has(name)
}

function toolResultStatus(output: unknown): AmaEvalToolOutcome['status'] {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return 'unavailable'
  }
  // Step results contain the raw execute() output, not the ModelMessage output wrapper.
  const result = output as Record<string, unknown>
  if (result.retrievalStatus === 'no_match' || result.source === 'no_matches') {
    return 'no_match'
  }
  if (
    result.retrievalStatus === 'empty' ||
    result.source === 'empty_blob' ||
    result.source === 'empty_files'
  ) {
    return 'empty'
  }
  if (result.available !== true || result.retrievalStatus === 'unavailable') {
    return 'unavailable'
  }
  return typeof result.content === 'string' && result.content.trim() ? 'found' : 'empty'
}

export function extractToolOutcomes(result: GenerateResultWithToolCalls): AmaEvalToolOutcome[] {
  return (result.steps ?? [result]).flatMap((step, index) =>
    (step.toolCalls ?? []).flatMap((call): AmaEvalToolOutcome[] => {
      if (!isKnownToolName(call.toolName)) {
        return []
      }
      const invalid = call.invalid === true
      const matchesCall = (part: { toolCallId?: string; toolName?: string }) =>
        typeof call.toolCallId === 'string' &&
        call.toolCallId.length > 0 &&
        part.toolCallId === call.toolCallId &&
        part.toolName === call.toolName
      const failed = (step.content ?? []).some(
        (part) => part.type === 'tool-error' && matchesCall(part),
      )
      const completed = (step.toolResults ?? []).find(matchesCall)
      // SDK invalid-call errors also appear in content. They never prove execution.
      const hasOutcome = !invalid && (failed || completed !== undefined)
      const output = completed?.output
      const reused =
        output !== null &&
        typeof output === 'object' &&
        'executionStatus' in output &&
        output.executionStatus === 'reused'
      // A deduplicated attempt retains its result but did not invoke the loader again.
      const executed = hasOutcome && !reused
      return [
        {
          step: index,
          name: call.toolName,
          invalid,
          executed,
          status: !hasOutcome
            ? 'not_executed'
            : failed
              ? 'error'
              : toolResultStatus(completed?.output),
        },
      ]
    }),
  )
}

export function extractGenerationDiagnostics(
  result: GenerateResultWithToolCalls,
): AmaEvalGenerationDiagnostics {
  return {
    finishReason: typeof result.finishReason === 'string' ? result.finishReason : undefined,
    stepCount: result.steps?.length ?? 0,
    usage: sanitizeUsageMetadata(result.usage),
    totalUsage: sanitizeUsageMetadata(result.totalUsage),
    stepFinishReasons: (result.steps ?? []).flatMap((step) =>
      typeof step.finishReason === 'string' ? [step.finishReason] : [],
    ),
    toolOutcomes: extractToolOutcomes(result),
  }
}

const PUBLIC_FIELDS: Record<string, string[]> = {
  start: ['type', 'messageId'],
  'start-step': ['type'],
  'finish-step': ['type'],
  'text-start': ['type', 'id'],
  'text-delta': ['type', 'id', 'delta'],
  'text-end': ['type', 'id'],
  finish: ['type', 'finishReason'],
  error: ['type', 'errorText'],
  abort: ['type'],
}

export async function generatePublicEvalCase(
  evalCase: AmaEvalCase,
  options: CreateAmaAgentOptions,
): Promise<{ output: string; toolCalls: string[]; diagnostics: AmaEvalGenerationDiagnostics }> {
  const started = Date.now()
  let serverResult: GenerateResultWithToolCalls | undefined
  let drained: Promise<void> = Promise.resolve()
  let observed: Promise<void> = Promise.resolve()
  let firstTextTokenMs: number | undefined
  let wirePrivacyPassed = true
  let protocolPassed = true
  let publicFinished = false
  let errorKind: string | undefined
  const modelConfig = options.modelConfig ?? getAmaModelConfig()
  const agent = createAmaAgent({
    ...options,
    modelConfig,
    onFinish: async (event) => {
      serverResult = event
      await options.onFinish?.(event)
    },
  })
  const transport = new DefaultChatTransport({
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: UIMessage[] }
      const agentTimeoutMs = await prepareAmaGeneration({
        inference: Boolean(modelConfig.inference),
        requestStartedAt: started,
        signal: init?.signal ?? undefined,
      })
      const response = createAmaPublicStreamResponse(
        await createAgentUIStreamResponse({
          agent,
          uiMessages: body.messages,
          abortSignal: init?.signal ?? undefined,
          timeout: { totalMs: agentTimeoutMs },
          sendReasoning: false,
          sendSources: false,
          onError: (error) =>
            `AMA_ERROR:${getAmaStreamErrorDetails(error, 'server_stream').errorKind}`,
          consumeSseStream: ({ stream }) => {
            drained = consumeStream({ stream })
            return drained
          },
        }),
      )
      observed = (async () => {
        const reader = parseJsonEventStream({
          stream: response.clone().body!,
          schema: uiMessageChunkSchema,
        }).getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) {
              break
            }
            if (!value.success) {
              protocolPassed = false
              continue
            }
            const event = value.value
            const fields = PUBLIC_FIELDS[event.type]
            if (!fields || Object.keys(event).some((key) => !fields.includes(key))) {
              wirePrivacyPassed = false
            }
            if (
              event.type === 'text-delta' &&
              event.delta.trim() &&
              firstTextTokenMs === undefined
            ) {
              firstTextTokenMs = Date.now() - started
            }
            if (event.type === 'finish') {
              publicFinished = true
            }
            if (event.type === 'error') {
              protocolPassed = false
              errorKind = getAmaStreamErrorDetails(
                new Error(event.errorText),
                'client_stream',
              ).errorKind
            }
            if (event.type === 'abort') {
              protocolPassed = false
              errorKind = 'aborted'
            }
          }
        } catch (error) {
          protocolPassed = false
          errorKind = getAmaStreamErrorDetails(error, 'client_stream').errorKind
        } finally {
          reader.releaseLock()
        }
      })()
      return response
    },
  })
  const chat = new Chat({
    transport,
    messages: (evalCase.priorMessages ?? []).map((message, index) => ({
      id: `prior-${index}`,
      role: message.role,
      parts: [{ type: 'text', text: message.content }],
    })),
    onError: (error) => {
      errorKind = getAmaStreamErrorDetails(error, 'client_stream').errorKind
    },
  })
  try {
    await chat.sendMessage({ text: evalCase.prompt })
  } catch (error) {
    errorKind = getAmaStreamErrorDetails(error, 'client_stream').errorKind
  }
  await Promise.all([
    drained.catch(() => {
      protocolPassed = false
    }),
    observed,
  ])
  const latest = chat.messages.at(-1)
  const output =
    latest?.role === 'assistant'
      ? latest.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
      : ''
  const diagnostics = extractGenerationDiagnostics(serverResult ?? {})
  const provider = serverResult?.providerMetadata?.gateway?.provider
  return {
    output,
    toolCalls: extractToolCalls(serverResult ?? {}),
    diagnostics: {
      ...diagnostics,
      latencyMs: Date.now() - started,
      firstTextTokenMs,
      errorKind,
      wirePrivacyPassed,
      protocolPassed: protocolPassed && publicFinished && !chat.error,
      serverFinishReceived: serverResult !== undefined,
      toolSequence: (serverResult?.steps ?? []).flatMap((step, index) =>
        (step.toolCalls ?? []).flatMap((call) =>
          typeof call.toolName === 'string' ? [{ step: index, name: call.toolName }] : [],
        ),
      ),
      responseModel: serverResult?.response?.modelId,
      ...(typeof provider === 'string' ? { provider } : {}),
    },
  }
}
