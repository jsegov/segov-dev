import { parseAmaInferenceHeaders } from '@/lib/ama-model-config'

export type AmaWakeResult = 'skipped' | 'warmed' | 'warming' | 'failed'
export type AmaInferenceReadinessResult = AmaWakeResult | 'timed_out'

const DEFAULT_WAKE_TIMEOUT_MS = 45_000
const DEFAULT_READINESS_TIMEOUT_MS = 135_000
const DEFAULT_READINESS_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_READINESS_INITIAL_DELAY_MS = 500
const DEFAULT_READINESS_MAX_DELAY_MS = 5_000

function getRequestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs))
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (ms <= 0) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }
  })
}

/**
 * Pre-warms the scale-to-zero inference endpoint so the container boots while
 * the visitor is still typing their first message. Hits `/models` — the
 * cheapest OpenAI-compatible request that still counts as endpoint activity
 * (which is what starts a cold container and resets its scaledown clock).
 *
 * Server-side only: the request carries the endpoint credentials
 * (AMA_INFERENCE_HEADERS / AMA_INFERENCE_API_KEY), which must never reach the
 * browser. No-ops when the gateway path is active (no AMA_INFERENCE_BASE_URL) —
 * gateway models have no cold start to hide.
 */
export async function wakeAmaInferenceEndpoint(
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<AmaWakeResult> {
  const baseURL = process.env.AMA_INFERENCE_BASE_URL?.trim()
  if (!baseURL) {
    return 'skipped'
  }

  try {
    const headers: Record<string, string> = {
      ...parseAmaInferenceHeaders(process.env.AMA_INFERENCE_HEADERS, 'AMA_INFERENCE_HEADERS'),
    }
    const apiKey = process.env.AMA_INFERENCE_API_KEY?.trim()
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`
    }

    const response = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
      method: 'GET',
      headers,
      signal: getRequestSignal(options.timeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS, options.signal),
    })
    const result: AmaWakeResult = response.ok
      ? 'warmed'
      : response.status === 503
        ? 'warming'
        : 'failed'
    await response.body?.cancel().catch(() => undefined)
    // Modal app.server intentionally answers 503 while a scale-to-zero
    // container is restoring. This is a readiness state, not a failed model
    // request, and callers may poll it within their own execution budget.
    return result
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? error
    }
    return 'failed'
  }
}

/**
 * Waits only for the documented scale-to-zero 503 state. Authentication,
 * configuration, and other endpoint failures are returned immediately so the
 * real model request can surface their more specific AI SDK classification.
 */
export async function waitForAmaInferenceEndpoint(
  options: {
    timeoutMs?: number
    requestTimeoutMs?: number
    initialDelayMs?: number
    maxDelayMs?: number
    signal?: AbortSignal
  } = {},
): Promise<AmaInferenceReadinessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_READINESS_REQUEST_TIMEOUT_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_READINESS_MAX_DELAY_MS
  const deadline = Date.now() + timeoutMs
  let nextDelayMs = options.initialDelayMs ?? DEFAULT_READINESS_INITIAL_DELAY_MS

  while (true) {
    options.signal?.throwIfAborted()
    const remainingMs = Math.max(1, deadline - Date.now())
    const result = await wakeAmaInferenceEndpoint({
      timeoutMs: Math.min(requestTimeoutMs, remainingMs),
      signal: options.signal,
    })

    if (result !== 'warming') {
      return result
    }

    const delayBudgetMs = deadline - Date.now()
    if (delayBudgetMs <= 0) {
      return 'timed_out'
    }

    await delay(Math.min(nextDelayMs, delayBudgetMs), options.signal)
    nextDelayMs = Math.min(Math.max(nextDelayMs * 2, 1), maxDelayMs)
  }
}
