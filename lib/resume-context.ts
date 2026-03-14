import { get as getBlob } from '@vercel/blob'

export const RESUME_UNAVAILABLE_MESSAGE =
  'Resume context is unavailable right now. For accurate details, please use the Career and Projects pages on this site.'

interface ResumeContextResult {
  available: boolean
  source: 'blob' | 'missing_path' | 'missing_blob' | 'blob_fetch_failed' | 'empty_blob'
  content: string
}

function unavailable(source: ResumeContextResult['source']): ResumeContextResult {
  return {
    available: false,
    source,
    content: RESUME_UNAVAILABLE_MESSAGE,
  }
}

export async function getResumeContextFromBlob(): Promise<ResumeContextResult> {
  const pathname = process.env.BLOB_RESUME_PATH?.trim()
  if (!pathname) {
    return unavailable('missing_path')
  }

  try {
    const blobResult = await getBlob(pathname, { access: 'private' })
    if (!blobResult || blobResult.statusCode === 304) {
      return unavailable('missing_blob')
    }

    const text = await new Response(blobResult.stream).text()
    const content = text.trim()

    if (!content) {
      return unavailable('empty_blob')
    }

    return {
      available: true,
      source: 'blob',
      content,
    }
  } catch {
    return unavailable('blob_fetch_failed')
  }
}
