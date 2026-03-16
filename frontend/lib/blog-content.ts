import matter from 'gray-matter'
import { get as getBlob, list } from '@vercel/blob'

const DEFAULT_COVER_IMAGE = '/placeholder.svg?height=600&width=800'

export interface BlogPost {
  title: string
  slug: string
  publishedDate: string
  excerpt: string
  coverImage: {
    url: string
  }
  content: string
  bodyMarkdown: string
}

function normalizeBlogPrefix(prefix: string | undefined): string | null {
  const trimmedPrefix = prefix?.trim()
  if (!trimmedPrefix) {
    return null
  }

  return trimmedPrefix.endsWith('/') ? trimmedPrefix : `${trimmedPrefix}/`
}

function isDirectChildMarkdownBlob(pathname: string, prefix: string): boolean {
  if (!pathname.startsWith(prefix)) {
    return false
  }

  const relativePath = pathname.slice(prefix.length)
  return Boolean(relativePath) && !relativePath.includes('/') && relativePath.endsWith('.md')
}

function getSlugFromPathname(pathname: string): string {
  const fileName = pathname.split('/').pop() ?? ''
  return fileName.replace(/\.md$/, '')
}

function getFrontmatterString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback
  }

  const trimmedValue = value.trim()
  return trimmedValue || fallback
}

function getPublishedDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString()
  }

  return getFrontmatterString(value, new Date().toISOString())
}

function parseBlogPost(pathname: string, fileContents: string): BlogPost {
  const { data: frontmatter, content } = matter(fileContents)

  return {
    title: getFrontmatterString(frontmatter.title, 'Untitled Post'),
    slug: getSlugFromPathname(pathname),
    publishedDate: getPublishedDate(frontmatter.publishedDate),
    excerpt: getFrontmatterString(frontmatter.excerpt, 'No excerpt available'),
    coverImage: {
      url: getFrontmatterString(frontmatter.coverImage, DEFAULT_COVER_IMAGE),
    },
    content,
    bodyMarkdown: content,
  }
}

async function readPrivateBlobText(pathname: string): Promise<string | null> {
  const blobResult = await getBlob(pathname, { access: 'private', useCache: false })
  if (!blobResult || blobResult.statusCode === 304 || !blobResult.stream) {
    return null
  }

  const text = await new Response(blobResult.stream).text()
  return text.trim() ? text : null
}

async function fetchBlogPostFromPathname(pathname: string): Promise<BlogPost | null> {
  try {
    const fileContents = await readPrivateBlobText(pathname)
    if (!fileContents) {
      return null
    }

    return parseBlogPost(pathname, fileContents)
  } catch (error) {
    console.error(`Error fetching blog post blob "${pathname}"`, error)
    return null
  }
}

async function listBlogPostPathnames(prefix: string): Promise<string[]> {
  try {
    const pathnames: string[] = []
    let cursor: string | undefined

    do {
      const result = await list({ prefix, cursor })

      for (const blob of result.blobs) {
        if (isDirectChildMarkdownBlob(blob.pathname, prefix)) {
          pathnames.push(blob.pathname)
        }
      }

      cursor = result.cursor

      if (!result.hasMore) {
        break
      }
    } while (cursor)

    return pathnames
  } catch (error) {
    console.error('Error fetching blog posts', error)
    return []
  }
}

function isBlogPost(post: BlogPost | null): post is BlogPost {
  return post !== null
}

async function getValidatedBlogPosts(prefix: string): Promise<BlogPost[]> {
  const pathnames = await listBlogPostPathnames(prefix)
  const posts = await Promise.all(pathnames.map((pathname) => fetchBlogPostFromPathname(pathname)))

  return posts.filter(isBlogPost).sort((a, b) => {
    return new Date(b.publishedDate).getTime() - new Date(a.publishedDate).getTime()
  })
}

export async function getBlogPosts(): Promise<BlogPost[]> {
  const prefix = normalizeBlogPrefix(process.env.BLOB_BLOG_PREFIX)
  if (!prefix) {
    return []
  }

  return getValidatedBlogPosts(prefix)
}

export async function getBlogPostBySlug(slug: string): Promise<BlogPost | null> {
  const prefix = normalizeBlogPrefix(process.env.BLOB_BLOG_PREFIX)
  const trimmedSlug = slug.trim()

  if (!prefix || !trimmedSlug || trimmedSlug.includes('/')) {
    return null
  }

  return fetchBlogPostFromPathname(`${prefix}${trimmedSlug}.md`)
}

export async function getAllBlogSlugs(): Promise<string[]> {
  const prefix = normalizeBlogPrefix(process.env.BLOB_BLOG_PREFIX)
  if (!prefix) {
    return []
  }

  const posts = await getValidatedBlogPosts(prefix)
  return posts.map((post) => post.slug)
}
