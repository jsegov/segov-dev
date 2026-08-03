import type { UIMessage } from 'ai'

export const AMA_ERROR_TOKEN_PREFIX = 'AMA_ERROR:'
export const AMA_ERROR_KIND_HEADER = 'X-Ama-Error-Kind'

export const AMA_STREAM_ERROR_KINDS = [
  'aborted',
  'network',
  'timeout',
  'rate_limit',
  'authentication',
  'provider_unavailable',
  'provider_response',
  'empty_response',
  'invalid_request',
  'invalid_tool_call',
  'ui_stream_protocol',
  'configuration',
  'unknown',
] as const

export type AmaStreamErrorKind = (typeof AMA_STREAM_ERROR_KINDS)[number]

export interface AmaStreamErrorDetails {
  errorType: string
  errorKind: AmaStreamErrorKind
  retryable: boolean
  statusCode?: number
}

export type AmaStreamErrorContext = 'request' | 'server_stream' | 'client_stream'

const ERROR_KIND_SET = new Set<string>(AMA_STREAM_ERROR_KINDS)

const TOOL_ERROR_TYPES = new Set([
  'AI_InvalidToolInputError',
  'AI_NoSuchToolError',
  'AI_ToolCallRepairError',
  'AI_ToolCallNotFoundForApprovalError',
])

const REQUEST_ERROR_TYPES = new Set([
  'AI_InvalidDataContentError',
  'AI_InvalidMessageRoleError',
  'AI_InvalidToolApprovalError',
  'AI_InvalidToolApprovalSignatureError',
  'AI_MessageConversionError',
  'AI_MissingToolResultsError',
  'AI_TypeValidationError',
])

const CONFIGURATION_ERROR_TYPES = new Set([
  'AmaModelConfigurationError',
  'AmaTraceConfigurationError',
  'AI_InvalidArgumentError',
  'AI_LoadAPIKeyError',
  'AI_LoadSettingError',
  'AI_NoSuchModelError',
  'AI_NoSuchProviderError',
  'AI_UnsupportedFunctionalityError',
  'AI_UnsupportedModelVersionError',
])

const PROVIDER_RESPONSE_ERROR_TYPES = new Set([
  'AI_EmptyResponseBodyError',
  'AI_InvalidResponseDataError',
  'AI_InvalidStreamPartError',
  'AI_JSONParseError',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getErrorType(error: unknown): string {
  if (error instanceof Error) {
    return error.name
  }

  if (isRecord(error) && typeof error.name === 'string') {
    return error.name
  }

  return typeof error
}

function getErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message
  }

  return isRecord(error) && typeof error.message === 'string' ? error.message : undefined
}

function getStatusCode(error: unknown): number | undefined {
  if (!isRecord(error) || typeof error.statusCode !== 'number') {
    return undefined
  }

  return Number.isInteger(error.statusCode) && error.statusCode >= 100 && error.statusCode <= 599
    ? error.statusCode
    : undefined
}

function getBoolean(error: unknown, key: string): boolean | undefined {
  return isRecord(error) && typeof error[key] === 'boolean' ? error[key] : undefined
}

function getString(error: unknown, key: string): string | undefined {
  return isRecord(error) && typeof error[key] === 'string' ? error[key] : undefined
}

function collectErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  const queue: unknown[] = [error]
  const seen = new Set<unknown>()

  while (queue.length > 0 && chain.length < 8) {
    const current = queue.shift()
    if (current === undefined || seen.has(current)) {
      continue
    }

    seen.add(current)
    chain.push(current)

    if (isRecord(current)) {
      queue.push(current.lastError, current.cause, current.originalError)
    }
  }

  return chain
}

function parseErrorToken(message: string | undefined): AmaStreamErrorKind | undefined {
  if (!message?.startsWith(AMA_ERROR_TOKEN_PREFIX)) {
    return undefined
  }

  const kind = message.slice(AMA_ERROR_TOKEN_PREFIX.length)
  return ERROR_KIND_SET.has(kind) ? (kind as AmaStreamErrorKind) : undefined
}

function parseErrorKind(value: string | null): AmaStreamErrorKind | undefined {
  return value && ERROR_KIND_SET.has(value) ? (value as AmaStreamErrorKind) : undefined
}

function isRetryableKind(kind: AmaStreamErrorKind): boolean {
  return !['aborted', 'authentication', 'configuration', 'invalid_request'].includes(kind)
}

function classifyStatusCode(statusCode: number, isRetryable?: boolean): AmaStreamErrorKind {
  if (statusCode === 401 || statusCode === 403) {
    return 'authentication'
  }

  if (statusCode === 408 || statusCode === 504) {
    return 'timeout'
  }

  if (statusCode === 429) {
    return 'rate_limit'
  }

  if (statusCode >= 500 || isRetryable) {
    return 'provider_unavailable'
  }

  return 'provider_response'
}

function classifyChatHttpStatus(statusCode: number): AmaStreamErrorKind {
  if (statusCode === 400 || statusCode === 413 || statusCode === 422) {
    return 'invalid_request'
  }

  if (statusCode === 404) {
    return 'configuration'
  }

  return classifyStatusCode(statusCode)
}

function classifyKnownMessage(message: string | undefined): AmaStreamErrorKind | undefined {
  if (!message) {
    return undefined
  }

  const normalized = message.toLowerCase()
  if (normalized.includes('function_invocation_timeout')) {
    return 'timeout'
  }

  if (
    normalized.includes('failed to fetch') ||
    normalized.includes('load failed') ||
    normalized.includes('network') ||
    normalized.includes('connection') ||
    normalized.includes('socket') ||
    normalized.includes('econn') ||
    normalized.includes('terminated')
  ) {
    return 'network'
  }

  if (normalized === 'the response body is empty.') {
    return 'provider_response'
  }

  return undefined
}

export function getAmaStreamErrorDetails(
  error: unknown,
  context: AmaStreamErrorContext = 'request',
): AmaStreamErrorDetails {
  const errorType = getErrorType(error)
  const chain = collectErrorChain(error)

  for (const item of chain) {
    const tokenKind = parseErrorToken(getErrorMessage(item))
    if (tokenKind) {
      return {
        errorType,
        errorKind: tokenKind,
        retryable: isRetryableKind(tokenKind),
      }
    }
  }

  for (const item of chain) {
    const itemType = getErrorType(item)
    if (itemType === 'TimeoutError') {
      return { errorType, errorKind: 'timeout', retryable: true }
    }
  }

  for (const item of chain) {
    if (getErrorType(item) === 'AbortError') {
      return { errorType, errorKind: 'aborted', retryable: false }
    }
  }

  for (const item of chain) {
    if (getErrorType(item) !== 'AI_APICallError') {
      continue
    }

    const statusCode = getStatusCode(item)
    const providerRetryable = getBoolean(item, 'isRetryable')
    const errorKind = statusCode
      ? classifyStatusCode(statusCode, providerRetryable)
      : providerRetryable
        ? 'provider_unavailable'
        : 'provider_response'

    return {
      errorType,
      errorKind,
      retryable: providerRetryable ?? isRetryableKind(errorKind),
      ...(statusCode ? { statusCode } : {}),
    }
  }

  for (const item of chain) {
    const itemType = getErrorType(item)
    if (itemType === 'AI_UIMessageStreamError') {
      return { errorType, errorKind: 'ui_stream_protocol', retryable: true }
    }
    if (itemType === 'AI_NoOutputGeneratedError' || itemType === 'AI_NoContentGeneratedError') {
      return { errorType, errorKind: 'empty_response', retryable: true }
    }
    if (TOOL_ERROR_TYPES.has(itemType)) {
      return { errorType, errorKind: 'invalid_tool_call', retryable: true }
    }
    if (itemType === 'AI_TypeValidationError' && context !== 'request') {
      return {
        errorType,
        errorKind: context === 'client_stream' ? 'ui_stream_protocol' : 'provider_response',
        retryable: true,
      }
    }
    if (REQUEST_ERROR_TYPES.has(itemType)) {
      return { errorType, errorKind: 'invalid_request', retryable: false }
    }
    if (CONFIGURATION_ERROR_TYPES.has(itemType)) {
      return { errorType, errorKind: 'configuration', retryable: false }
    }
    if (PROVIDER_RESPONSE_ERROR_TYPES.has(itemType)) {
      return { errorType, errorKind: 'provider_response', retryable: true }
    }
  }

  for (const item of chain) {
    if (getErrorType(item) !== 'AI_RetryError') {
      continue
    }

    const reason = getString(item, 'reason')
    return {
      errorType,
      errorKind: reason === 'abort' ? 'aborted' : 'provider_unavailable',
      retryable: reason !== 'abort',
    }
  }

  for (const item of chain) {
    const knownKind = classifyKnownMessage(getErrorMessage(item))
    if (knownKind) {
      return { errorType, errorKind: knownKind, retryable: isRetryableKind(knownKind) }
    }
  }

  return { errorType, errorKind: 'unknown', retryable: true }
}

export function createAmaPublicErrorToken(
  error: unknown,
  context: AmaStreamErrorContext = 'server_stream',
): string {
  return `${AMA_ERROR_TOKEN_PREFIX}${getAmaStreamErrorDetails(error, context).errorKind}`
}

export function createAmaErrorTokenForKind(kind: AmaStreamErrorKind): string {
  return `${AMA_ERROR_TOKEN_PREFIX}${kind}`
}

/**
 * Prevents a Vercel proxy, firewall, or platform error page from becoming the
 * browser-visible Error.message while retaining a useful, safe category.
 */
export function sanitizeAmaChatHttpResponse(response: Response): Response {
  if (response.ok) {
    return response
  }

  const kind =
    parseErrorKind(response.headers.get(AMA_ERROR_KIND_HEADER)) ??
    classifyChatHttpStatus(response.status)
  void response.body?.cancel().catch(() => undefined)

  return new Response(createAmaErrorTokenForKind(kind), {
    status: response.status,
    statusText: response.statusText,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
}

export function getAmaErrorPresentation(
  error: unknown,
  context: AmaStreamErrorContext = 'client_stream',
): {
  title: string
  description: string
} {
  const { errorKind } = getAmaStreamErrorDetails(error, context)

  switch (errorKind) {
    case 'network':
      return {
        title: 'Connection interrupted',
        description: 'The response connection was interrupted. Please retry.',
      }
    case 'timeout':
      return {
        title: 'Response timed out',
        description: 'The model took too long to respond. Please retry.',
      }
    case 'rate_limit':
    case 'provider_unavailable':
      return {
        title: 'Model temporarily unavailable',
        description: 'The model is temporarily unavailable. Please retry in a moment.',
      }
    case 'provider_response':
    case 'ui_stream_protocol':
      return {
        title: 'Response interrupted',
        description: 'The model response could not be completed. Please retry.',
      }
    case 'empty_response':
    case 'invalid_tool_call':
      return {
        title: 'No answer generated',
        description: 'The model did not produce a usable answer. Please retry.',
      }
    case 'invalid_request':
      return {
        title: 'Conversation could not be processed',
        description: 'Clear this conversation and try your question again.',
      }
    case 'authentication':
    case 'configuration':
      return {
        title: 'Chat unavailable',
        description: 'The chat service is not configured correctly. Please try again later.',
      }
    case 'aborted':
      return {
        title: 'Response stopped',
        description: 'The response was stopped.',
      }
    default:
      return {
        title: 'Chat error',
        description: 'Failed to get a response. Please retry.',
      }
  }
}

export function summarizeAmaUiMessage(message: UIMessage) {
  const text = message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')

  return {
    id: message.id,
    role: message.role,
    partTypes: message.parts.map((part) => part.type),
    textLength: text.length,
    trimmedTextLength: text.trim().length,
  }
}

export function getAmaStreamErrorType(error: unknown): string {
  return getAmaStreamErrorDetails(error).errorType
}
