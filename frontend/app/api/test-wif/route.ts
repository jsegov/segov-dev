import { NextResponse } from 'next/server'
import { getVercelOidcToken } from '@/lib/gcp-wif'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const token = await getVercelOidcToken()
    return NextResponse.json({ ok: true, len: token.length })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
