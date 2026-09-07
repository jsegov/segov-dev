import { waitForAmaInferenceEndpoint, type AmaInferenceReadinessResult } from '@/lib/ama-wake'

// Startup and generation share the same budget in the route and live evaluations.
// Leave 15 seconds below Vercel's invocation limit for a classified failure.
export const AMA_REQUEST_BUDGET_MS = 285_000
export const AMA_INFERENCE_STARTUP_TIMEOUT_MS = 135_000

export async function prepareAmaGeneration(options: {
  inference: boolean
  requestStartedAt: number
  signal?: AbortSignal
  onReadiness?: (result: AmaInferenceReadinessResult) => void
}): Promise<number> {
  if (!options.inference) {
    return AMA_REQUEST_BUDGET_MS
  }

  const readiness = await waitForAmaInferenceEndpoint({
    timeoutMs: AMA_INFERENCE_STARTUP_TIMEOUT_MS,
    signal: options.signal,
  })
  options.onReadiness?.(readiness)
  if (readiness === 'timed_out') {
    const error = new Error('The inference endpoint did not become ready in time.')
    error.name = 'TimeoutError'
    throw error
  }

  return Math.max(1_000, AMA_REQUEST_BUDGET_MS - (Date.now() - options.requestStartedAt))
}
