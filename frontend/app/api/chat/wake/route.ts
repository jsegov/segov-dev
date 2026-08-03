import { wakeAmaInferenceEndpoint } from '@/lib/ama-wake'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Fired (fire-and-forget) by the chat UI on mount so a scale-to-zero
 * inference container boots while the visitor types their first message.
 * Modal app.server returns 503 as soon as the cold container starts restoring,
 * so this route reports `warming` quickly; the chat route performs the bounded
 * readiness poll if the visitor submits before restoration completes.
 *
 * Exposure note: this is unauthenticated and can spin up a GPU container,
 * but that is the same exposure as POST /api/chat itself; Modal proxy auth
 * still rejects anyone hitting the endpoint URL directly.
 */
export async function POST() {
  const status = await wakeAmaInferenceEndpoint()
  return Response.json({ status })
}
