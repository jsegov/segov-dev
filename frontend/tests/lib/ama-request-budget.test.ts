// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareAmaGeneration } from '@/lib/ama-request-budget'
import type { AmaInferenceReadinessResult } from '@/lib/ama-wake'

const { waitForAmaInferenceEndpoint } = vi.hoisted(() => ({
  waitForAmaInferenceEndpoint: vi.fn(),
}))

vi.mock('@/lib/ama-wake', () => ({ waitForAmaInferenceEndpoint }))

beforeEach(() => waitForAmaInferenceEndpoint.mockReset())
afterEach(() => vi.useRealTimers())

describe('AMA shared readiness and generation budget', () => {
  it('deducts both earlier request processing and cold-start waiting from generation time', async () => {
    vi.useFakeTimers()
    const requestStartedAt = Date.UTC(2026, 8, 6)
    vi.setSystemTime(requestStartedAt + 15_000)
    let resolveReadiness!: (result: AmaInferenceReadinessResult) => void
    waitForAmaInferenceEndpoint.mockImplementationOnce(
      () =>
        new Promise<AmaInferenceReadinessResult>((resolve) => {
          resolveReadiness = resolve
        }),
    )
    const onReadiness = vi.fn()

    const pending = prepareAmaGeneration({ inference: true, requestStartedAt, onReadiness })
    vi.setSystemTime(requestStartedAt + 45_000)
    resolveReadiness('warmed')

    await expect(pending).resolves.toBe(240_000)
    expect(waitForAmaInferenceEndpoint).toHaveBeenCalledExactlyOnceWith({
      timeoutMs: 135_000,
      signal: undefined,
    })
    expect(onReadiness).toHaveBeenCalledExactlyOnceWith('warmed')
  })

  it('preserves request cancellation while readiness is pending', async () => {
    const controller = new AbortController()
    const cancelled = new DOMException('Request cancelled', 'AbortError')
    waitForAmaInferenceEndpoint.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const onReadiness = vi.fn()
    const pending = prepareAmaGeneration({
      inference: true,
      requestStartedAt: Date.now(),
      signal: controller.signal,
      onReadiness,
    })
    const rejected = expect(pending).rejects.toBe(cancelled)

    controller.abort(cancelled)

    await rejected
    expect(waitForAmaInferenceEndpoint).toHaveBeenCalledExactlyOnceWith({
      timeoutMs: 135_000,
      signal: controller.signal,
    })
    expect(onReadiness).not.toHaveBeenCalled()
  })
})
