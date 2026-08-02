import { wakeAmaInferenceEndpoint } from '@/lib/ama-wake'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Fired (fire-and-forget) by the chat UI on mount so a scale-to-zero
 * inference container boots while the visitor types their first message.
 * Holding the request open until the endpoint answers is deliberate — an
 * aborted request may cancel the container spin-up it triggered.
 *
 * Exposure note: this is unauthenticated and can spin up a GPU container,
 * but that is the same exposure as POST /api/chat itself; Modal proxy auth
 * still rejects anyone hitting the endpoint URL directly.
 */
export async function POST() {
  const status = await wakeAmaInferenceEndpoint()
  return Response.json({ status })
}
