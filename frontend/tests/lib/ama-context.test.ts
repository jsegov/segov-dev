import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { get as getBlob, list } from '@vercel/blob'
import {
  AMA_CONTEXT_UNAVAILABLE_MESSAGE,
  searchPersonalContextFromBlob,
  searchWorkContextFromBlob,
} from '@/lib/ama-context'

vi.mock('@vercel/blob', () => ({
  get: vi.fn(),
  list: vi.fn(),
}))

const getBlobMock = vi.mocked(getBlob)
const listBlobMock = vi.mocked(list)
const consoleErrorMock = vi.spyOn(console, 'error').mockImplementation(() => {})

function createListBlob(pathname: string, uploadedAt = '2025-01-01T00:00:00.000Z') {
  return {
    pathname,
    url: `https://blob.example/${pathname}`,
    downloadUrl: `https://blob.example/download/${pathname}`,
    size: 123,
    uploadedAt: new Date(uploadedAt),
    etag: `${pathname}-etag`,
  }
}

function createBlobResponse(content: string) {
  return {
    statusCode: 200,
    stream: new Response(content).body,
  } as Awaited<ReturnType<typeof getBlob>>
}

const cases = [
  { label: 'work', fn: searchWorkContextFromBlob, prefix: 'work/' },
  { label: 'personal', fn: searchPersonalContextFromBlob, prefix: 'personal/' },
] as const

describe.each(cases)('$label context search', ({ fn, prefix }) => {
  beforeEach(() => {
    vi.clearAllMocks()
    consoleErrorMock.mockClear()
  })

  afterAll(() => {
    consoleErrorMock.mockRestore()
  })

  it('lists paginated supported text blobs recursively and returns ranked matches', async () => {
    listBlobMock
      .mockResolvedValueOnce({
        blobs: [
          createListBlob(`${prefix}design-doc.md`),
          createListBlob(`${prefix}screenshot.png`),
          createListBlob(`${prefix}notes.txt`),
        ],
        cursor: 'page-2',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        blobs: [
          createListBlob(`${prefix}projects/autoresearch.MDX`),
          createListBlob('other-folder/skip.md'),
        ],
        hasMore: false,
      })

    getBlobMock.mockImplementation(async (pathname) => {
      if (pathname === `${prefix}design-doc.md`) {
        return createBlobResponse('Realtime sync architecture used queues and conflict handling.')
      }

      if (pathname === `${prefix}notes.txt`) {
        return createBlobResponse('Additional notes about UI polish.')
      }

      if (pathname === `${prefix}projects/autoresearch.MDX`) {
        return createBlobResponse(
          'Autoresearch architecture architecture architecture used retrieval and ranking.',
        )
      }

      return null
    })

    const result = await fn('Tell me about architecture retrieval')

    expect(listBlobMock).toHaveBeenNthCalledWith(1, { prefix, cursor: undefined })
    expect(listBlobMock).toHaveBeenNthCalledWith(2, { prefix, cursor: 'page-2' })
    expect(getBlobMock).toHaveBeenCalledTimes(3)
    expect(getBlobMock).toHaveBeenCalledWith(`${prefix}design-doc.md`, {
      access: 'private',
      useCache: false,
    })
    expect(getBlobMock).toHaveBeenCalledWith(`${prefix}projects/autoresearch.MDX`, {
      access: 'private',
      useCache: false,
    })
    expect(result.available).toBe(true)
    expect(result.source).toBe('blob')
    expect(result.matches).toHaveLength(2)
    expect(result.matches[0]?.pathname).toBe(`${prefix}projects/autoresearch.MDX`)
    expect(result.content).toContain(`Source 1: ${prefix}projects/autoresearch.MDX`)
    expect(result.content).toContain('retrieval and ranking')
  })

  it('returns no_supported_files when listed blobs have unsupported extensions', async () => {
    listBlobMock.mockResolvedValueOnce({
      blobs: [createListBlob(`${prefix}design.pdf`), createListBlob(`${prefix}image.png`)],
      hasMore: false,
    })

    const result = await fn('design')

    expect(result).toMatchObject({
      available: false,
      source: 'no_supported_files',
      content: AMA_CONTEXT_UNAVAILABLE_MESSAGE,
    })
    expect(getBlobMock).not.toHaveBeenCalled()
  })

  it('returns list_failed when Vercel Blob listing fails', async () => {
    listBlobMock.mockRejectedValueOnce(new Error('list failed'))

    const result = await fn('design')

    expect(result).toMatchObject({
      available: false,
      source: 'list_failed',
      content: AMA_CONTEXT_UNAVAILABLE_MESSAGE,
    })
  })

  it('returns blob_fetch_failed when all supported blobs fail to fetch', async () => {
    listBlobMock.mockResolvedValueOnce({
      blobs: [createListBlob(`${prefix}design.md`)],
      hasMore: false,
    })
    getBlobMock.mockRejectedValueOnce(new Error('fetch failed'))

    const result = await fn('design')

    expect(result).toMatchObject({
      available: false,
      source: 'blob_fetch_failed',
      content: AMA_CONTEXT_UNAVAILABLE_MESSAGE,
    })
  })

  it('returns empty_files when supported blobs are missing or empty', async () => {
    listBlobMock.mockResolvedValueOnce({
      blobs: [createListBlob(`${prefix}empty.md`), createListBlob(`${prefix}missing.txt`)],
      hasMore: false,
    })
    getBlobMock.mockImplementation(async (pathname) => {
      if (pathname === `${prefix}empty.md`) {
        return createBlobResponse('   ')
      }

      return null
    })

    const result = await fn('design')

    expect(result).toMatchObject({
      available: false,
      source: 'empty_files',
      content: AMA_CONTEXT_UNAVAILABLE_MESSAGE,
    })
  })

  it('returns no_matches when readable context does not match the query', async () => {
    listBlobMock.mockResolvedValueOnce({
      blobs: [createListBlob(`${prefix}design.md`)],
      hasMore: false,
    })
    getBlobMock.mockResolvedValueOnce(createBlobResponse('A note about unrelated portfolio copy.'))

    const result = await fn('distributed scheduler')

    expect(result).toMatchObject({
      available: false,
      source: 'no_matches',
      content: 'No matching AMA context was found for that question.',
    })
  })

  it('limits returned matches to the top five scored chunks', async () => {
    listBlobMock.mockResolvedValueOnce({
      blobs: Array.from({ length: 7 }, (_, index) => {
        return createListBlob(`${prefix}project-${index + 1}.md`)
      }),
      hasMore: false,
    })
    getBlobMock.mockImplementation(async (pathname) => {
      return createBlobResponse(`${pathname} scheduler scheduler scheduler`)
    })

    const result = await fn('scheduler')

    expect(result.available).toBe(true)
    expect(result.matches).toHaveLength(5)
    expect(result.content).toContain('Source 5:')
    expect(result.content).not.toContain('Source 6:')
  })

  it('stops paginating once the file cap is reached', async () => {
    listBlobMock.mockResolvedValueOnce({
      blobs: Array.from({ length: 25 }, (_, index) => {
        return createListBlob(`${prefix}doc-${String(index).padStart(2, '0')}.md`)
      }),
      cursor: 'page-2',
      hasMore: true,
    })
    getBlobMock.mockImplementation(async (pathname) => {
      return createBlobResponse(`${pathname} scheduler`)
    })

    const result = await fn('scheduler')

    expect(listBlobMock).toHaveBeenCalledTimes(1)
    expect(result.available).toBe(true)
  })

  it('matches short technical acronyms like go, ai, and c#', async () => {
    listBlobMock.mockResolvedValueOnce({
      blobs: [createListBlob(`${prefix}stack.md`)],
      hasMore: false,
    })
    getBlobMock.mockResolvedValueOnce(
      createBlobResponse('Jonathan shipped services in go and c# with ai-assisted tooling.'),
    )

    const result = await fn('Has Jonathan worked with Go, C#, or AI?')

    expect(result.available).toBe(true)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.score).toBeGreaterThanOrEqual(3)
  })

  it('does not match short technical terms inside longer English words', async () => {
    listBlobMock.mockResolvedValueOnce({
      blobs: [createListBlob(`${prefix}irrelevant.md`)],
      hasMore: false,
    })
    getBlobMock.mockResolvedValueOnce(
      createBlobResponse(
        'He was going to maintain the most available endpoints regardless of cost.',
      ),
    )

    const result = await fn('Jonathan Go AI OS')

    expect(result).toMatchObject({
      available: false,
      source: 'no_matches',
    })
  })
})
