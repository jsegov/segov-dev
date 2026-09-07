import { neon } from '@neondatabase/serverless'
import { randomUUID } from 'node:crypto'
import type { LanguageModelUsage, ModelMessage, ProviderMetadata } from 'ai'
import {
  AMA_PROMPT_MANIFEST,
  AMA_SYSTEM_PROMPT_VERSION,
  createAmaPromptManifest,
  getAmaSystemPromptVersion,
  type AmaAgentCallSettings,
  type AmaAgentSettings,
  type AMA_TOOL_DECLARATIONS,
} from '@/lib/ama-agent'

export type AmaRequestTrigger = 'submit-message' | 'regenerate-message'

interface AmaPromptManifest {
  instructions: string
  tools: typeof AMA_TOOL_DECLARATIONS
  callSettings: AmaAgentCallSettings
  toolAvailabilityPolicy?: string
}

export interface AmaTracePayload {
  readonly id: string
  readonly conversationId: string
  readonly turn: number
  readonly requestTrigger: AmaRequestTrigger
  readonly deploymentEnvironment: string
  readonly systemPromptVersion: string
  readonly promptManifest: AmaPromptManifest
  readonly model: string
  readonly responseModel: string
  readonly provider: string | null
  readonly inputMessages: readonly ModelMessage[]
  readonly responseMessages: readonly ModelMessage[]
  readonly totalUsage: LanguageModelUsage
  readonly finishReason: string
}

interface CreateAmaTraceCollectorOptions {
  traceId?: string
  conversationId: string
  requestTrigger: AmaRequestTrigger
  deploymentEnvironment: string
  model: string
  callSettings?: AmaAgentCallSettings
}

export interface AmaTraceCollector {
  readonly traceId: string
  readonly payload: Promise<AmaTracePayload | null>
  readonly prepareCall: NonNullable<AmaAgentSettings['prepareCall']>
  readonly onFinish: NonNullable<AmaAgentSettings['onFinish']>
  settleWithoutTrace: () => void
}

interface TraceWriteFailureLog {
  event: 'ama_trace_write_failed'
  traceId: string
  attemptCount: number
  errorName: string
  errorCode: string | null
  environment: string
}

type AmaTraceWriter = (trace: AmaTracePayload, signal: AbortSignal) => Promise<void>

export interface PersistAmaTraceOptions {
  databaseUrl?: string
  enabled?: boolean
  writer?: AmaTraceWriter
  sleep?: (milliseconds: number) => Promise<void>
  random?: () => number
  logFailure?: (event: TraceWriteFailureLog) => void
  maxAttempts?: number
  timeoutMs?: number
}

class AmaTraceConfigurationError extends Error {
  readonly code = 'AMA_TRACE_DATABASE_URL_MISSING'

  constructor() {
    super('DATABASE_URL is required when AMA trace logging is enabled.')
    this.name = 'AmaTraceConfigurationError'
  }
}

class AmaTraceTimeoutError extends Error {
  readonly code = 'ETIMEDOUT'

  constructor() {
    super('AMA trace write timed out.')
    this.name = 'AmaTraceTimeoutError'
  }
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return
  }

  Object.freeze(value)
  for (const child of Object.values(value)) {
    deepFreeze(child)
  }
}

function cloneImmutable<T>(value: T): T {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new TypeError('AMA trace value is not JSON serializable.')
  }

  const clone = JSON.parse(serialized) as T
  deepFreeze(clone)
  return clone
}

function getGatewayProvider(providerMetadata: ProviderMetadata | undefined): string | null {
  const gatewayMetadata = providerMetadata?.gateway
  const provider = gatewayMetadata?.provider
  return typeof provider === 'string' && provider.trim() ? provider : null
}

function getModelMessages(
  options: Parameters<AmaTraceCollector['prepareCall']>[0],
): ModelMessage[] | null {
  if ('messages' in options && Array.isArray(options.messages)) {
    return options.messages
  }

  if ('prompt' in options && Array.isArray(options.prompt)) {
    return options.prompt
  }

  return null
}

export function createAmaTraceCollector(
  options: CreateAmaTraceCollectorOptions,
): AmaTraceCollector {
  const traceId = options.traceId ?? randomUUID()
  const promptManifest = options.callSettings
    ? createAmaPromptManifest(options.callSettings)
    : AMA_PROMPT_MANIFEST
  const systemPromptVersion = options.callSettings
    ? getAmaSystemPromptVersion(promptManifest)
    : AMA_SYSTEM_PROMPT_VERSION
  let capturedInputMessages: readonly ModelMessage[] | null = null
  let settled = false
  let settlePayload: (payload: AmaTracePayload | null) => void = () => undefined
  const payload = new Promise<AmaTracePayload | null>((resolve) => {
    settlePayload = resolve
  })

  function settle(nextPayload: AmaTracePayload | null) {
    if (settled) {
      return
    }

    settled = true
    settlePayload(nextPayload)
  }

  const prepareCall: AmaTraceCollector['prepareCall'] = (callOptions) => {
    const messages = getModelMessages(callOptions)
    capturedInputMessages = messages ? cloneImmutable(messages) : null
    return callOptions
  }

  const onFinish: AmaTraceCollector['onFinish'] = (event) => {
    if (!capturedInputMessages || event.finishReason === 'error') {
      settle(null)
      return
    }

    try {
      const trace = cloneImmutable<AmaTracePayload>({
        id: traceId,
        conversationId: options.conversationId,
        turn: capturedInputMessages.filter((message) => message.role === 'user').length,
        requestTrigger: options.requestTrigger,
        deploymentEnvironment: options.deploymentEnvironment,
        systemPromptVersion,
        promptManifest,
        model: options.model,
        responseModel: event.response.modelId,
        provider: getGatewayProvider(event.providerMetadata),
        inputMessages: capturedInputMessages,
        responseMessages: event.response.messages,
        totalUsage: event.totalUsage,
        finishReason: event.finishReason,
      })
      settle(trace)
    } catch {
      settle(null)
    }
  }

  return {
    traceId,
    payload,
    prepareCall,
    onFinish,
    settleWithoutTrace: () => settle(null),
  }
}

function createNeonWriter(databaseUrl: string): AmaTraceWriter {
  const sql = neon(databaseUrl)

  return async (trace, signal) => {
    await sql.transaction(
      [
        sql`
          INSERT INTO public.ama_prompt_versions (
            version,
            instructions,
            tool_declarations,
            call_settings
          )
          VALUES (
            ${trace.systemPromptVersion},
            ${trace.promptManifest.instructions},
            ${JSON.stringify(trace.promptManifest.tools)}::jsonb,
            ${JSON.stringify({
              ...trace.promptManifest.callSettings,
              toolAvailabilityPolicy: trace.promptManifest.toolAvailabilityPolicy,
            })}::jsonb
          )
          ON CONFLICT (version) DO NOTHING
        `,
        sql`
          INSERT INTO public.ama_traces (
            id,
            conversation_id,
            turn,
            request_trigger,
            deployment_environment,
            system_prompt_version,
            model,
            response_model,
            provider,
            input_messages,
            response_messages,
            total_usage,
            finish_reason
          )
          VALUES (
            ${trace.id}::uuid,
            ${trace.conversationId},
            ${trace.turn},
            ${trace.requestTrigger},
            ${trace.deploymentEnvironment},
            ${trace.systemPromptVersion},
            ${trace.model},
            ${trace.responseModel},
            ${trace.provider},
            ${JSON.stringify(trace.inputMessages)}::jsonb,
            ${JSON.stringify(trace.responseMessages)}::jsonb,
            ${JSON.stringify(trace.totalUsage)}::jsonb,
            ${trace.finishReason}
          )
          ON CONFLICT (id) DO NOTHING
        `,
      ],
      {
        fetchOptions: {
          signal,
        },
      },
    )
  }
}

function getErrorProperty(error: unknown, property: 'code' | 'status' | 'statusCode'): unknown {
  if (error === null || typeof error !== 'object') {
    return undefined
  }

  const value = (error as Record<string, unknown>)[property]
  if (value !== undefined) {
    return value
  }

  return getErrorProperty((error as { cause?: unknown }).cause, property)
}

function getErrorCode(error: unknown): string | null {
  const code = getErrorProperty(error, 'code')
  return typeof code === 'string' && code ? code : null
}

function getErrorName(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name
  }

  return 'UnknownError'
}

export function isRetryableAmaTraceError(error: unknown): boolean {
  if (error instanceof AmaTraceTimeoutError) {
    return true
  }

  if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
    return true
  }

  const status = getErrorProperty(error, 'status') ?? getErrorProperty(error, 'statusCode')
  if (
    typeof status === 'number' &&
    (status === 408 || status === 429 || (status >= 500 && status <= 599))
  ) {
    return true
  }

  const code = getErrorCode(error)
  if (!code) {
    return false
  }

  if (
    code.startsWith('08') ||
    code.startsWith('40') ||
    code.startsWith('53') ||
    code === '55P03' ||
    /^57P0[1-3]$/.test(code)
  ) {
    return true
  }

  return [
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETDOWN',
    'ENETUNREACH',
    'ENOTFOUND',
    'ETIMEDOUT',
    'EAI_AGAIN',
  ].includes(code)
}

async function runWithTimeout(
  writer: AmaTraceWriter,
  trace: AmaTracePayload,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    await Promise.race([
      writer(trace, controller.signal),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new AmaTraceTimeoutError())
          controller.abort()
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

function defaultLogFailure(event: TraceWriteFailureLog) {
  console.error(JSON.stringify(event))
}

function getRetryDelay(attempt: number, random: () => number): number {
  const exponentialDelay = 250 * 2 ** (attempt - 1)
  return exponentialDelay + Math.floor(random() * exponentialDelay)
}

export async function persistAmaTrace(
  trace: AmaTracePayload,
  options: PersistAmaTraceOptions = {},
): Promise<void> {
  const enabled = options.enabled ?? process.env.AMA_TRACE_LOGGING_ENABLED !== '0'
  if (!enabled) {
    return
  }

  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL
  const logFailure = options.logFailure ?? defaultLogFailure
  if (!options.writer && !databaseUrl) {
    const error = new AmaTraceConfigurationError()
    logFailure({
      event: 'ama_trace_write_failed',
      traceId: trace.id,
      attemptCount: 0,
      errorName: error.name,
      errorCode: error.code,
      environment: trace.deploymentEnvironment,
    })
    return
  }

  const writer = options.writer ?? createNeonWriter(databaseUrl!)
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const random = options.random ?? Math.random
  const maxAttempts = options.maxAttempts ?? 3
  const timeoutMs = options.timeoutMs ?? 3_000
  let attemptCount = 0
  let lastError: unknown

  while (attemptCount < maxAttempts) {
    attemptCount += 1

    try {
      await runWithTimeout(writer, trace, timeoutMs)
      return
    } catch (error) {
      lastError = error
      if (attemptCount >= maxAttempts || !isRetryableAmaTraceError(error)) {
        break
      }

      await sleep(getRetryDelay(attemptCount, random))
    }
  }

  logFailure({
    event: 'ama_trace_write_failed',
    traceId: trace.id,
    attemptCount,
    errorName: getErrorName(lastError),
    errorCode: getErrorCode(lastError),
    environment: trace.deploymentEnvironment,
  })
}
