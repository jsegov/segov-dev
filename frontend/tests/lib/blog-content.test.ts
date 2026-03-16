import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { get as getBlob, list } from '@vercel/blob'
import { getAllBlogSlugs, getBlogPostBySlug, getBlogPosts } from '@/lib/blog-content'

vi.mock('@vercel/blob', () => ({
  get: vi.fn(),
  list: vi.fn(),
}))

const getBlobMock = vi.mocked(getBlob)
const listBlobMock = vi.mocked(list)
const consoleErrorMock = vi.spyOn(console, 'error').mockImplementation(() => {})

function createListBlob(pathname: string) {
  return {
    pathname,
    url: `https://blob.example/${pathname}`,
    downloadUrl: `https://blob.example/download/${pathname}`,
    size: 123,
    uploadedAt: new Date('2025-01-01T00:00:00.000Z'),
    etag: `${pathname}-etag`,
  }
}

describe('blog content backed by Vercel Blob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    consoleErrorMock.mockClear()
    delete process.env.BLOB_BLOG_PREFIX
  })

  afterAll(() => {
    consoleErrorMock.mockRestore()
  })

  it('lists paginated markdown posts, ignores nested files, and sorts by publishedDate', async () => {
    process.env.BLOB_BLOG_PREFIX = 'blog'

    listBlobMock
      .mockResolvedValueOnce({
        blobs: [
          createListBlob('blog/older-post.md'),
          createListBlob('blog/nested/skip-me.md'),
          createListBlob('blog/ignore.txt'),
        ],
        cursor: 'page-2',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        blobs: [createListBlob('blog/newer-post.md')],
        hasMore: false,
      })

    getBlobMock.mockImplementation(async (pathname) => {
      if (pathname === 'blog/older-post.md') {
        return {
          statusCode: 200,
          stream: new Response(`---
title: Older Post
slug: ignored-frontmatter-slug
publishedDate: 2024-01-01
excerpt: Older excerpt
coverImage: /older.png
---
Older body`).body,
        } as Awaited<ReturnType<typeof getBlob>>
      }

      if (pathname === 'blog/newer-post.md') {
        return {
          statusCode: 200,
          stream: new Response(`---
title: Newer Post
publishedDate: 2025-02-01
excerpt: Newer excerpt
---
Newer body`).body,
        } as Awaited<ReturnType<typeof getBlob>>
      }

      return null
    })

    const posts = await getBlogPosts()

    expect(listBlobMock).toHaveBeenNthCalledWith(1, { prefix: 'blog/', cursor: undefined })
    expect(listBlobMock).toHaveBeenNthCalledWith(2, { prefix: 'blog/', cursor: 'page-2' })
    expect(getBlobMock).toHaveBeenCalledTimes(2)
    expect(posts.map((post) => post.slug)).toEqual(['newer-post', 'older-post'])
    expect(posts[0]).toMatchObject({
      title: 'Newer Post',
      excerpt: 'Newer excerpt',
      coverImage: {
        url: '/placeholder.svg?height=600&width=800',
      },
    })
    expect(posts[1]).toMatchObject({
      title: 'Older Post',
      slug: 'older-post',
      excerpt: 'Older excerpt',
      coverImage: {
        url: '/older.png',
      },
    })
  })

  it('derives slugs from readable blob pathnames and filters unreadable ones', async () => {
    process.env.BLOB_BLOG_PREFIX = 'blog/'
    listBlobMock.mockResolvedValueOnce({
      blobs: [
        createListBlob('blog/first-post.md'),
        createListBlob('blog/second-post.md'),
        createListBlob('blog/nested/skip-me.md'),
        createListBlob('blog/unreadable.md'),
      ],
      hasMore: false,
    })
    getBlobMock.mockImplementation(async (pathname) => {
      if (pathname === 'blog/first-post.md' || pathname === 'blog/second-post.md') {
        return {
          statusCode: 200,
          stream: new Response(`---
title: ${pathname}
publishedDate: 2025-01-01
---
Body`).body,
        } as Awaited<ReturnType<typeof getBlob>>
      }

      return null
    })

    const slugs = await getAllBlogSlugs()

    expect(slugs).toEqual(['first-post', 'second-post'])
    expect(getBlobMock).toHaveBeenCalledWith('blog/first-post.md', {
      access: 'private',
      useCache: false,
    })
    expect(getBlobMock).toHaveBeenCalledWith('blog/second-post.md', {
      access: 'private',
      useCache: false,
    })
    expect(getBlobMock).toHaveBeenCalledWith('blog/unreadable.md', {
      access: 'private',
      useCache: false,
    })
  })

  it('fetches a post directly by slug and ignores slug frontmatter', async () => {
    process.env.BLOB_BLOG_PREFIX = 'blog'
    getBlobMock.mockResolvedValueOnce({
      statusCode: 200,
      stream: new Response(`---
title: Direct Blob Post
slug: some-other-slug
publishedDate: 2025-03-16
excerpt: Direct fetch
---
Blob body`).body,
    } as Awaited<ReturnType<typeof getBlob>>)

    const post = await getBlogPostBySlug('direct-blob-post')

    expect(getBlobMock).toHaveBeenCalledWith('blog/direct-blob-post.md', {
      access: 'private',
      useCache: false,
    })
    expect(post).toMatchObject({
      title: 'Direct Blob Post',
      slug: 'direct-blob-post',
      excerpt: 'Direct fetch',
    })
  })

  it('returns empty results when BLOB_BLOG_PREFIX is missing', async () => {
    await expect(getBlogPosts()).resolves.toEqual([])
    await expect(getAllBlogSlugs()).resolves.toEqual([])
    await expect(getBlogPostBySlug('missing')).resolves.toBeNull()
    expect(listBlobMock).not.toHaveBeenCalled()
    expect(getBlobMock).not.toHaveBeenCalled()
  })

  it('skips unreadable, empty, and malformed blobs while keeping valid posts', async () => {
    process.env.BLOB_BLOG_PREFIX = 'blog'
    listBlobMock.mockResolvedValueOnce({
      blobs: [
        createListBlob('blog/valid.md'),
        createListBlob('blog/empty.md'),
        createListBlob('blog/malformed.md'),
        createListBlob('blog/missing.md'),
      ],
      hasMore: false,
    })

    getBlobMock.mockImplementation(async (pathname) => {
      if (pathname === 'blog/valid.md') {
        return {
          statusCode: 200,
          stream: new Response(`---
title: Valid Post
publishedDate: 2024-04-01
---
Valid body`).body,
        } as Awaited<ReturnType<typeof getBlob>>
      }

      if (pathname === 'blog/empty.md') {
        return {
          statusCode: 200,
          stream: new Response('   ').body,
        } as Awaited<ReturnType<typeof getBlob>>
      }

      if (pathname === 'blog/malformed.md') {
        return {
          statusCode: 200,
          stream: new Response(`---
title: broken
publishedDate: [oops
---
Malformed body`).body,
        } as Awaited<ReturnType<typeof getBlob>>
      }

      return null
    })

    const posts = await getBlogPosts()

    expect(posts).toHaveLength(1)
    expect(posts[0]?.slug).toBe('valid')
  })

  it('returns empty lists on list failure and null when a direct blob lookup is missing', async () => {
    process.env.BLOB_BLOG_PREFIX = 'blog'
    listBlobMock.mockRejectedValue(new Error('list failed'))
    getBlobMock.mockResolvedValueOnce(null)

    await expect(getBlogPosts()).resolves.toEqual([])
    await expect(getAllBlogSlugs()).resolves.toEqual([])
    await expect(getBlogPostBySlug('missing')).resolves.toBeNull()
  })
})
