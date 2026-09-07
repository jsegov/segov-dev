import { expect } from '@playwright/test'
import { completeChatFixture, installChatFixture, storageKey, test } from './fixtures'
import { renderMarkdownFixture } from './render-markdown'

test('streams, announces once on completion, retries, restores history and clears', async ({
  page,
}) => {
  await installChatFixture(page, {
    responses: ['A complete **answer** about engineering.', 'A regenerated answer about projects.'],
    manualFinish: true,
  })
  await page.goto('/ama')
  const input = page.getByRole('textbox', { name: 'Ask a question' })
  const transcript = page.getByRole('region', { name: 'Conversation' })
  const announcement = page.getByRole('status')
  await expect(announcement).toBeEmpty()
  await input.fill('Tell me about your engineering work')
  await input.press('Enter')
  await expect(input).toBeDisabled()
  await expect(transcript).toContainText('A complete')
  await expect(announcement).toBeEmpty()
  await completeChatFixture(page)
  await expect(announcement).toHaveText('A complete **answer** about engineering.')
  await expect(input).toBeEnabled()
  await expect(transcript.locator('strong, [data-streamdown="strong"]')).toHaveText('answer')

  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(announcement).toBeEmpty()
  await expect(transcript).toContainText('A regenerated')
  await completeChatFixture(page)
  await expect(announcement).toHaveText('A regenerated answer about projects.')
  await expect(input).toBeEnabled()
  await page.reload()
  await expect(transcript).toContainText('A regenerated answer about projects.')
  await expect(announcement).toBeEmpty()
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(transcript).toContainText('Ask me anything about my work and projects.')
  await expect(transcript).not.toContainText('A regenerated answer')
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey)).toBeNull()
})

test('stops a partial response without reporting a failed completion', async ({ page }) => {
  await installChatFixture(page, {
    responses: ['A response that would finish much later.'],
    manualFinish: true,
  })
  await page.goto('/ama')
  const input = page.getByRole('textbox', { name: 'Ask a question' })
  await input.fill('Tell me about your projects')
  await input.press('Enter')
  await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('A response')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(input).toBeEnabled()
  await expect(page.getByRole('status')).toBeEmpty()
  await expect(page.getByText('Response interrupted', { exact: true })).toHaveCount(0)
})

for (const failure of ['blocked', 'quota'] as const) {
  test(`keeps chat and Clear working after ${failure} storage failure`, async ({ page }) => {
    await installChatFixture(page, { responses: ['An in-memory answer.'] })
    await page.addInitScript(
      ({ failure, storageKey }) => {
        if (failure === 'blocked') {
          Object.defineProperty(window, 'localStorage', {
            get() {
              throw new DOMException('Storage unavailable', 'SecurityError')
            },
          })
        } else {
          const originalSetItem = Storage.prototype.setItem
          Storage.prototype.setItem = function (key, value) {
            if (key === storageKey) {
              throw new DOMException('Storage full', 'QuotaExceededError')
            }
            originalSetItem.call(this, key, value)
          }
        }
      },
      { failure, storageKey },
    )
    await page.goto('/ama')
    const input = page.getByRole('textbox', { name: 'Ask a question' })
    await input.fill('Tell me about your work')
    await input.press('Enter')
    await expect(page.getByRole('region', { name: 'Conversation' })).toContainText(
      'An in-memory answer.',
    )
    await expect(input).toBeEnabled()
    await expect(page.getByText('Local history unavailable', { exact: true })).toHaveCount(1)
    await page.getByRole('button', { name: 'Dismiss notification' }).click()
    await expect(page.getByText('Local history unavailable', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Conversation' })).not.toContainText(
      'An in-memory answer.',
    )
    await expect(page.getByText('Local history unavailable', { exact: true })).toHaveCount(0)
  })
}

test('honors System theme while retaining the initial dark default', async ({ page }) => {
  await installChatFixture(page)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/ama')
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByRole('button', { name: 'Toggle theme' }).click()
  await page.getByRole('menuitem', { name: 'System', exact: true }).click()
  await expect(page.locator('html')).toHaveClass(/light/)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/dark/)
})

test('mobile navigation supports keyboard opening and Escape focus restoration', async ({
  page,
}) => {
  await installChatFixture(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/ama')
  const toggle = page.getByRole('button', { name: 'Toggle navigation' })
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const career = page.getByRole('link', { name: 'Career', exact: true })
  await career.focus()
  await page.keyboard.press('Escape')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toBeFocused()
  await expect(career).not.toBeVisible()
})

test('browser preserves the blog renderer structure and fragment navigation', async ({ page }) => {
  const content =
    '## Example\n\n```ts\nconst typed = true\n```\n\n```\nplain block\n```\n\n![Example](/placeholder.svg "Caption")\n\n[Jump](#target)'
  const markup = renderMarkdownFixture(content)
  await page.route('**/__fixtures/markdown', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><body>${markup}<p id="target">Target</p></body></html>`,
    }),
  )
  await page.goto('/__fixtures/markdown')
  await expect(page.locator('pre')).toHaveCount(2)
  await expect(page.locator('pre > code')).toHaveCount(2)
  await expect(page.locator('pre pre, p div, [node]')).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'Example' })).toBeVisible()
  await page.getByRole('link', { name: 'Jump' }).click()
  await expect(page).toHaveURL(/#target$/)
})
