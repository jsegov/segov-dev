import { get as getBlob, list } from '@vercel/blob'

const SUPPORTED_CONTEXT_EXTENSIONS = ['.md', '.mdx', '.txt']
const MAX_FILES_TO_READ = 25
const MAX_MATCHES = 5
const MAX_CHUNK_LENGTH = 1600
const MAX_EXCERPT_LENGTH = 1200
const MAX_TOTAL_CONTENT_LENGTH = 6000

const STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'and',
  'are',
  'can',
  'did',
  'does',
  'for',
  'from',
  'have',
  'how',
  'into',
  'jonathan',
  'personal',
  'segov',
  'segovia',
  'that',
  'the',
  'their',
  'this',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'with',
  'work',
  'you',
  'your',
])

const SHORT_TECHNICAL_TERMS = new Set([
  'ai',
  'cd',
  'ci',
  'c#',
  'db',
  'f#',
  'go',
  'js',
  'ml',
  'os',
  'qa',
  'ts',
  'ui',
  'ux',
])

export const AMA_CONTEXT_UNAVAILABLE_MESSAGE =
  'Additional AMA context is unavailable right now. For accurate details, please use the Career and Projects pages on this site.'

type AmaContextSource =
  | 'blob'
  | 'list_failed'
  | 'no_supported_files'
  | 'blob_fetch_failed'
  | 'empty_files'
  | 'no_matches'

export interface AmaContextMatch {
  pathname: string
  uploadedAt: string
  size: number
  score: number
  excerpt: string
}

export interface AmaContextSearchResult {
  available: boolean
  source: AmaContextSource
  query: string
  matches: AmaContextMatch[]
  content: string
}

interface ContextBlobMetadata {
  pathname: string
  uploadedAt: Date
  size: number
}

interface ReadableContextBlob extends ContextBlobMetadata {
  content: string
}

interface ScoredContextChunk {
  pathname: string
  uploadedAt: Date
  size: number
  score: number
  excerpt: string
}

function unavailable(source: AmaContextSource, query: string): AmaContextSearchResult {
  const content =
    source === 'no_matches'
      ? 'No matching AMA context was found for that question.'
      : AMA_CONTEXT_UNAVAILABLE_MESSAGE

  return {
    available: false,
    source,
    query,
    matches: [],
    content,
  }
}

function isSupportedContextBlob(pathname: string, prefix: string): boolean {
  if (!pathname.startsWith(prefix)) {
    return false
  }

  const relativePath = pathname.slice(prefix.length)
  if (!relativePath) {
    return false
  }

  return SUPPORTED_CONTEXT_EXTENSIONS.some((extension) =>
    relativePath.toLowerCase().endsWith(extension),
  )
}

async function listContextBlobs(prefix: string): Promise<ContextBlobMetadata[] | null> {
  try {
    const blobs: ContextBlobMetadata[] = []
    let cursor: string | undefined

    do {
      const result = await list({ prefix, cursor })

      for (const blob of result.blobs) {
        if (isSupportedContextBlob(blob.pathname, prefix)) {
          blobs.push({
            pathname: blob.pathname,
            uploadedAt: blob.uploadedAt,
            size: blob.size,
          })
          if (blobs.length >= MAX_FILES_TO_READ) {
            break
          }
        }
      }

      if (blobs.length >= MAX_FILES_TO_READ || !result.hasMore) {
        break
      }

      cursor = result.cursor
    } while (cursor)

    return blobs.slice(0, MAX_FILES_TO_READ)
  } catch (error) {
    console.error('Error listing AMA context blobs', error)
    return null
  }
}

async function readContextBlob(blob: ContextBlobMetadata): Promise<ReadableContextBlob | null> {
  const blobResult = await getBlob(blob.pathname, { access: 'private', useCache: false })
  if (!blobResult || blobResult.statusCode === 304 || !blobResult.stream) {
    return null
  }

  const text = await new Response(blobResult.stream).text()
  const content = text.trim()
  if (!content) {
    return null
  }

  return {
    ...blob,
    content,
  }
}

function getSearchTerms(query: string): string[] {
  const rawTerms = query
    .toLowerCase()
    .match(/[a-z0-9+#]+/g)
    ?.filter((term) => {
      if (STOP_WORDS.has(term)) {
        return false
      }
      if (term.length >= 3) {
        return true
      }
      return SHORT_TECHNICAL_TERMS.has(term)
    })

  const terms = rawTerms ?? []
  return Array.from(new Set(terms))
}

function countOccurrences(text: string, term: string): number {
  let count = 0
  let index = text.indexOf(term)

  while (index !== -1) {
    count += 1
    index = text.indexOf(term, index + term.length)
  }

  return count
}

function getChunkScore(chunk: string, pathname: string, terms: string[]): number {
  if (terms.length === 0) {
    return 0
  }

  const normalizedChunk = chunk.toLowerCase()
  const normalizedPathname = pathname.toLowerCase()

  return terms.reduce((score, term) => {
    const chunkMatches = countOccurrences(normalizedChunk, term)
    const pathMatches = countOccurrences(normalizedPathname, term)
    return score + chunkMatches + pathMatches * 2
  }, 0)
}

function splitLongText(text: string): string[] {
  const chunks: string[] = []

  for (let start = 0; start < text.length; start += MAX_CHUNK_LENGTH) {
    chunks.push(text.slice(start, start + MAX_CHUNK_LENGTH).trim())
  }

  return chunks.filter(Boolean)
}

function chunkContent(content: string): string[] {
  if (content.length <= MAX_CHUNK_LENGTH) {
    return [content]
  }

  const chunks: string[] = []
  let currentChunk = ''

  for (const paragraph of content.split(/\n{2,}/)) {
    const trimmedParagraph = paragraph.trim()
    if (!trimmedParagraph) {
      continue
    }

    if (trimmedParagraph.length > MAX_CHUNK_LENGTH) {
      if (currentChunk) {
        chunks.push(currentChunk)
        currentChunk = ''
      }

      chunks.push(...splitLongText(trimmedParagraph))
      continue
    }

    const nextChunk = currentChunk ? `${currentChunk}\n\n${trimmedParagraph}` : trimmedParagraph
    if (nextChunk.length > MAX_CHUNK_LENGTH) {
      chunks.push(currentChunk)
      currentChunk = trimmedParagraph
    } else {
      currentChunk = nextChunk
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk)
  }

  return chunks
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, maxLength).trimEnd()}...`
}

function scoreContextBlobs(blobs: ReadableContextBlob[], terms: string[]): AmaContextMatch[] {
  const scoredChunks: ScoredContextChunk[] = []

  for (const blob of blobs) {
    for (const chunk of chunkContent(blob.content)) {
      const score = getChunkScore(chunk, blob.pathname, terms)
      if (score > 0) {
        scoredChunks.push({
          pathname: blob.pathname,
          uploadedAt: blob.uploadedAt,
          size: blob.size,
          score,
          excerpt: truncateText(chunk, MAX_EXCERPT_LENGTH),
        })
      }
    }
  }

  return scoredChunks
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score
      }

      return a.pathname.localeCompare(b.pathname)
    })
    .slice(0, MAX_MATCHES)
    .map((match) => ({
      pathname: match.pathname,
      uploadedAt: match.uploadedAt.toISOString(),
      size: match.size,
      score: match.score,
      excerpt: match.excerpt,
    }))
}

function buildContent(matches: AmaContextMatch[]): string {
  let content = matches
    .map((match, index) => {
      return [
        `Source ${index + 1}: ${match.pathname}`,
        `Uploaded: ${match.uploadedAt}`,
        `Size: ${match.size} bytes`,
        match.excerpt,
      ].join('\n')
    })
    .join('\n\n')

  content = truncateText(content, MAX_TOTAL_CONTENT_LENGTH)
  return content
}

export const WORK_CONTEXT_PREFIX = 'work/'
export const PERSONAL_CONTEXT_PREFIX = 'personal/'

export function searchWorkContextFromBlob(query: string): Promise<AmaContextSearchResult> {
  return searchContextFromBlob(WORK_CONTEXT_PREFIX, query)
}

export function searchPersonalContextFromBlob(query: string): Promise<AmaContextSearchResult> {
  return searchContextFromBlob(PERSONAL_CONTEXT_PREFIX, query)
}

async function searchContextFromBlob(
  prefix: string,
  query: string,
): Promise<AmaContextSearchResult> {
  const trimmedQuery = query.trim()

  const blobs = await listContextBlobs(prefix)
  if (!blobs) {
    return unavailable('list_failed', trimmedQuery)
  }

  if (blobs.length === 0) {
    return unavailable('no_supported_files', trimmedQuery)
  }

  let fetchFailures = 0
  const readableBlobs = (
    await Promise.all(
      blobs.map(async (blob) => {
        try {
          return await readContextBlob(blob)
        } catch (error) {
          fetchFailures += 1
          console.error(`Error fetching AMA context blob "${blob.pathname}"`, error)
          return null
        }
      }),
    )
  ).filter((readableBlob): readableBlob is ReadableContextBlob => readableBlob !== null)

  if (readableBlobs.length === 0) {
    return unavailable(fetchFailures > 0 ? 'blob_fetch_failed' : 'empty_files', trimmedQuery)
  }

  const matches = scoreContextBlobs(readableBlobs, getSearchTerms(trimmedQuery))
  if (matches.length === 0) {
    return unavailable('no_matches', trimmedQuery)
  }

  return {
    available: true,
    source: 'blob',
    query: trimmedQuery,
    matches,
    content: buildContent(matches),
  }
}
