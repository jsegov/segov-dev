import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wakeAmaInferenceEndpoint } from '@/lib/ama-wake'

describe('wakeAmaInferenceEndpoint', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    delete process.env.AMA_INFERENCE_BASE_URL
    delete process.env.AMA_INFERENCE_API_KEY
    delete process.env.AMA_INFERENCE_HEADERS
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
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

  it('returns failed when the request throws or times out', async () => {
    process.env.AMA_INFERENCE_BASE_URL = 'https://example.modal.run/v1'
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout')) as unknown as typeof fetch

    await expect(wakeAmaInferenceEndpoint()).resolves.toBe('failed')
  })
})
