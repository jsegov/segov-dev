import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  amaSessionSnapshotSchema,
  AMA_SESSION_COOKIE_NAME,
  type AmaSessionSnapshot,
} from '@/lib/ama-routing'

const TEST_SESSION_SECRET = 'ama-session-test-secret'

export function createAmaSessionCookieValue(snapshot: AmaSessionSnapshot): string {
  const payload = Buffer.from(JSON.stringify(snapshot)).toString('base64url')
  const signature = signAmaSessionPayload(payload)

  return `${payload}.${signature}`
}

export function readAmaSessionSnapshotFromCookieHeader(
  cookieHeader: string | null,
): AmaSessionSnapshot | null {
  if (!cookieHeader) {
    return null
  }

  const cookies = parseCookieHeader(cookieHeader)
  const rawValue = cookies[AMA_SESSION_COOKIE_NAME]
  if (!rawValue) {
    return null
  }

  return decodeAmaSessionCookieValue(rawValue)
}

export function decodeAmaSessionCookieValue(value: string): AmaSessionSnapshot | null {
  const separatorIndex = value.lastIndexOf('.')
  if (separatorIndex === -1) {
    return null
  }

  const payload = value.slice(0, separatorIndex)
  const signature = value.slice(separatorIndex + 1)

  if (!verifyAmaSessionSignature(payload, signature)) {
    return null
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const result = amaSessionSnapshotSchema.safeParse(decoded)

    return result.success ? result.data : null
  } catch {
    return null
  }
}

export function getAmaSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  }
}

function parseCookieHeader(cookieHeader: string): Record<string, string> {
  return cookieHeader.split(';').reduce<Record<string, string>>((cookies, cookie) => {
    const [rawName, ...rawValueParts] = cookie.trim().split('=')
    if (!rawName || rawValueParts.length === 0) {
      return cookies
    }

    try {
      cookies[rawName] = decodeURIComponent(rawValueParts.join('='))
    } catch {
      cookies[rawName] = rawValueParts.join('=')
    }

    return cookies
  }, {})
}

function signAmaSessionPayload(payload: string): string {
  return createHmac('sha256', getAmaSessionSecret()).update(payload).digest('base64url')
}

function verifyAmaSessionSignature(payload: string, signature: string): boolean {
  const expectedSignature = signAmaSessionPayload(payload)
  const provided = Buffer.from(signature)
  const expected = Buffer.from(expectedSignature)

  if (provided.length !== expected.length) {
    return false
  }

  return timingSafeEqual(provided, expected)
}

function getAmaSessionSecret(): string {
  const secret = process.env.AMA_SESSION_SECRET?.trim()
  if (secret) {
    return secret
  }

  if (process.env.NODE_ENV === 'test') {
    return TEST_SESSION_SECRET
  }

  throw new Error('AMA_SESSION_SECRET is required')
}
