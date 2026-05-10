import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get as getBlob } from '@vercel/blob'
import { getResumeContextFromBlob, RESUME_UNAVAILABLE_MESSAGE } from '@/lib/resume-context'

vi.mock('@vercel/blob', () => ({
  get: vi.fn(),
}))

const getBlobMock = vi.mocked(getBlob)

describe('getResumeContextFromBlob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.BLOB_RESUME_PATH
  })

  it('returns deterministic fallback when BLOB_RESUME_PATH is missing', async () => {
    const result = await getResumeContextFromBlob()

    expect(result).toEqual({
      available: false,
      source: 'missing_path',
      content: RESUME_UNAVAILABLE_MESSAGE,
    })
  })

  it('returns deterministic fallback when blob lookup fails', async () => {
    process.env.BLOB_RESUME_PATH = 'resume/latest.md'
    getBlobMock.mockRejectedValueOnce(new Error('blob error'))

    const result = await getResumeContextFromBlob()

    expect(result).toEqual({
      available: false,
      source: 'blob_fetch_failed',
      content: RESUME_UNAVAILABLE_MESSAGE,
    })
  })

  it('returns deterministic fallback when blob is missing', async () => {
    process.env.BLOB_RESUME_PATH = 'resume/latest.md'
    getBlobMock.mockResolvedValueOnce(null)

    const result = await getResumeContextFromBlob()

    expect(result).toEqual({
      available: false,
      source: 'missing_blob',
      content: RESUME_UNAVAILABLE_MESSAGE,
    })
  })

  it('returns parsed blob content when available', async () => {
    process.env.BLOB_RESUME_PATH = 'resume/latest.md'
    getBlobMock.mockResolvedValueOnce({
      statusCode: 200,
      stream: new Response('  Jonathan resume content  ').body,
    } as Awaited<ReturnType<typeof getBlob>>)

    const result = await getResumeContextFromBlob()

    expect(result).toEqual({
      available: true,
      source: 'blob',
      content: 'Jonathan resume content',
    })
  })
})
