import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForAmaInferenceEndpoint, wakeAmaInferenceEndpoint } from '@/lib/ama-wake'

describe('wakeAmaInferenceEndpoint', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    delete process.env.AMA_INFERENCE_BASE_URL
    delete process.env.AMA_INFERENCE_API_KEY
    delete process.env.AMA_INFERENCE_HEADERS
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('skips without touching the network when no inference endpoint is set', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await expect(wakeAmaInferenceEndpoint()).resolves.toBe('skipped')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('pings /models with the configured custom headers', async () => {
    process.env.AMA_INFERENCE_BASE_URL = 'https://example.modal.run/v1'
    process.env.AMA_INFERENCE_HEADERS = '{"Modal-Key":"wk-abc","Modal-Secret":"ws-def"}'

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await expect(wakeAmaInferenceEndpoint()).resolves.toBe('warmed')
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.modal.run/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { 'Modal-Key': 'wk-abc', 'Modal-Secret': 'ws-def' },
      }),
    )
  })

  it('sends a Bearer header when AMA_INFERENCE_API_KEY is set', async () => {
    process.env.AMA_INFERENCE_BASE_URL = 'https://inference.example.com/v1/'
    process.env.AMA_INFERENCE_API_KEY = 'secret-key'

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await expect(wakeAmaInferenceEndpoint()).resolves.toBe('warmed')
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://inference.example.com/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer secret-key' },
      }),
    )
  })

  it('returns failed on a non-ok response', async () => {
    process.env.AMA_INFERENCE_BASE_URL = 'https://example.modal.run/v1'
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch

    await expect(wakeAmaInferenceEndpoint()).resolves.toBe('failed')
  })

  it('reports a 503 as warming instead of a terminal failure', async () => {
    process.env.AMA_INFERENCE_BASE_URL = 'https://example.modal.direct/v1'
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch

    await expect(wakeAmaInferenceEndpoint()).resolves.toBe('warming')
  })

  it('polls the scale-to-zero 503 state until the endpoint is ready', async () => {
    process.env.AMA_INFERENCE_BASE_URL = 'https://example.modal.direct/v1'
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await expect(
      waitForAmaInferenceEndpoint({ timeoutMs: 1_000, initialDelayMs: 0 }),
    ).resolves.toBe('warmed')
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('polls an internally timed-out readiness request until the endpoint is ready', async () => {
    process.env.AMA_INFERENCE_BASE_URL = 'https://example.modal.direct/v1'
    const timeoutController = new AbortController()
    vi.spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(timeoutController.signal)
      .mockReturnValueOnce(new AbortController().signal)
    const fetchSpy = vi
      .fn()
      .mockImplementationOnce(async () => {
        timeoutController.abort(new DOMException('timed out', 'TimeoutError'))
        throw timeoutController.signal.reason
      })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await expect(
      waitForAmaInferenceEndpoint({ timeoutMs: 1_000, initialDelayMs: 0 }),
    ).resolves.toBe('warmed')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('stops polling when the readiness budget expires', async () => {
    process.env.AMA_INFERENCE_BASE_URL = 'https://example.modal.direct/v1'
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await expect(waitForAmaInferenceEndpoint({ timeoutMs: 0, initialDelayMs: 0 })).resolves.toBe(
      'timed_out',
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('reports its own request timeout as warming', async () => {
    process.env.AMA_INFERENCE_BASE_URL = 'https://example.modal.direct/v1'
    const timeoutController = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal)
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      timeoutController.abort(new DOMException('timed out', 'TimeoutError'))
      throw timeoutController.signal.reason
    }) as unknown as typeof fetch

    await expect(wakeAmaInferenceEndpoint({ timeoutMs: 10 })).resolves.toBe('warming')
  })

  it('propagates a caller abort instead of treating it as warming', async () => {
    process.env.AMA_INFERENCE_BASE_URL = 'https://example.modal.direct/v1'
    const caller = new AbortController()
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      caller.abort(new DOMException('request cancelled', 'AbortError'))
      throw caller.signal.reason
    }) as unknown as typeof fetch

    await expect(wakeAmaInferenceEndpoint({ signal: caller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('returns failed when the request throws an ordinary network error', async () => {
    process.env.AMA_INFERENCE_BASE_URL = 'https://example.modal.run/v1'
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('connection refused')) as unknown as typeof fetch

    await expect(wakeAmaInferenceEndpoint()).resolves.toBe('failed')
  })

  it('returns failed without fetching when custom auth headers are invalid', async () => {
    process.env.AMA_INFERENCE_BASE_URL = 'https://example.modal.run/v1'
    process.env.AMA_INFERENCE_HEADERS = 'private malformed credentials'
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await expect(wakeAmaInferenceEndpoint()).resolves.toBe('failed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
