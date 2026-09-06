import { expect, test as base, type Page } from '@playwright/test'

export const storageKey = 'segov-dev:ama:v1'

type FixtureWindow = Window & { __amaFinishFixtureResponse?: () => void }

export async function completeChatFixture(page: Page) {
  await expect
    .poll(() => page.evaluate(() => !!(window as FixtureWindow).__amaFinishFixtureResponse))
    .toBe(true)
  await page.evaluate(() => (window as FixtureWindow).__amaFinishFixtureResponse?.())
}

export const test = base.extend<{ pageErrors: Error[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: Error[] = []
      page.on('pageerror', (error) => errors.push(error))
      await use(errors)
      expect(errors, 'No uncaught browser errors').toEqual([])
    },
    { auto: true },
  ],
})

// Exercise the real chat transport and UI with deterministic browser-side SSE.
// Only chat/wake requests are replaced; no model or private content is accessed.
export async function installChatFixture(
  page: Page,
  options: { responses?: string[]; finishDelayMs?: number; manualFinish?: boolean } = {},
) {
  await page.addInitScript(
    ({ responses, finishDelayMs, manualFinish }) => {
      const originalFetch = window.fetch.bind(window)
      const fixtureWindow = window as FixtureWindow
      let requestCount = 0
      window.fetch = async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          window.location.href,
        )
        if (url.origin !== window.location.origin) {
          return originalFetch(input, init)
        }
        if (url.pathname === '/api/chat/wake') {
          return new Response(null, { status: 204 })
        }
        if (url.pathname !== '/api/chat') {
          return originalFetch(input, init)
        }

        const text = responses[Math.min(requestCount++, responses.length - 1)]
        const textId = `text-${requestCount}`
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        const encoder = new TextEncoder()
        let cleanup = () => {}
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            let ended = false
            const timers: ReturnType<typeof setTimeout>[] = []
            const emit = (chunk: unknown) => {
              if (!ended) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
              }
            }
            const abort = () => {
              if (ended) {
                return
              }
              ended = true
              cleanup()
              controller.error(new DOMException('The request was aborted', 'AbortError'))
            }
            cleanup = () => {
              timers.forEach(clearTimeout)
              signal?.removeEventListener('abort', abort)
              delete fixtureWindow.__amaFinishFixtureResponse
            }
            signal?.addEventListener('abort', abort, { once: true })
            if (signal?.aborted) {
              abort()
              return
            }

            emit({ type: 'start', messageId: `answer-${requestCount}` })
            emit({ type: 'start-step' })
            emit({ type: 'text-start', id: textId })
            const finish = () => {
              if (!ended) {
                emit({ type: 'text-delta', id: textId, delta: text.slice(16) })
                emit({ type: 'text-end', id: textId })
                emit({ type: 'finish-step' })
                emit({ type: 'finish', finishReason: 'stop' })
                controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                ended = true
                cleanup()
                controller.close()
              }
            }
            timers.push(
              setTimeout(
                () => emit({ type: 'text-delta', id: textId, delta: text.slice(0, 16) }),
                40,
              ),
            )
            if (manualFinish) {
              fixtureWindow.__amaFinishFixtureResponse = finish
            } else {
              timers.push(setTimeout(finish, finishDelayMs))
            }
          },
          cancel() {
            cleanup()
          },
        })
        return new Response(body, {
          headers: {
            'Content-Type': 'text/event-stream',
            'x-vercel-ai-ui-message-stream': 'v1',
          },
        })
      }
    },
    {
      responses: options.responses ?? ['A complete answer about engineering.'],
      finishDelayMs: options.finishDelayMs ?? 250,
      manualFinish: options.manualFinish ?? false,
    },
  )
}
