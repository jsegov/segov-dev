import { NextResponse } from 'next/server'
import { AMA_SESSION_COOKIE_NAME, buildAmaSessionSnapshot } from '@/lib/ama-routing'
import {
  createAmaSessionCookieValue,
  getAmaSessionCookieOptions,
  readAmaSessionSnapshotFromCookieHeader,
} from '@/lib/ama-session'
import { readAmaRoutingStoreFromEdgeConfig } from '@/lib/ama-routing-store'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  try {
    const existingSession = readAmaSessionSnapshotFromCookieHeader(request.headers.get('cookie'))
    if (existingSession) {
      return new NextResponse(null, {
        status: 204,
        headers: {
          'Cache-Control': 'no-store',
        },
      })
    }

    const store = await readAmaRoutingStoreFromEdgeConfig()
    const snapshot = buildAmaSessionSnapshot(store)

    const response = new NextResponse(null, {
      status: 204,
      headers: {
        'Cache-Control': 'no-store',
      },
    })

    response.cookies.set({
      name: AMA_SESSION_COOKIE_NAME,
      value: createAmaSessionCookieValue(snapshot),
      ...getAmaSessionCookieOptions(),
    })

    return response
  } catch {
    return new NextResponse('AMA session unavailable.', { status: 500 })
  }
}
