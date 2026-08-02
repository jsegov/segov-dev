import { parseAmaInferenceHeaders } from '@/lib/ama-model-config'

export type AmaWakeResult = 'skipped' | 'warmed' | 'failed'

const DEFAULT_WAKE_TIMEOUT_MS = 45_000

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
  options: { timeoutMs?: number } = {},
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
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS),
    })
    return response.ok ? 'warmed' : 'failed'
  } catch {
    return 'failed'
  }
}
