import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownRenderer } from '@/components/markdown-renderer'

afterEach(cleanup)

describe('blog Markdown rendering', () => {
  it('renders labeled and unlabeled fences in a single block wrapper and preserves inline code', () => {
    const { container } = render(
      <MarkdownRenderer
        content={'`inline`\n\n```ts\nconst typed = true\n```\n\n```\nplain block\n```'}
      />,
    )
    expect(container.querySelectorAll('pre')).toHaveLength(2)
    expect(container.querySelector('pre pre')).toBeNull()
    expect(container.querySelectorAll('pre > code')).toHaveLength(2)
    expect(container.querySelector('code.language-ts')).toHaveTextContent('const typed = true')
    expect(screen.getByText('inline').closest('pre')).toBeNull()
    expect(container.querySelector('[node]')).toBeNull()
  })

  it('keeps image markup valid inside Markdown paragraphs', () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer content={'Before ![Example](/placeholder.svg "Caption") after.'} />,
    )
    expect(html).not.toMatch(/<div|<p[^>]*>Caption/)
    const { container } = render(
      <MarkdownRenderer content={'Before ![Example](/placeholder.svg "Caption") after.'} />,
    )
    expect(screen.getByRole('img', { name: 'Example' })).toBeInTheDocument()
    expect(screen.getByText('Caption').tagName).toBe('SPAN')
    expect(container.querySelectorAll('p')).toHaveLength(1)
  })

  it('preserves fragment and relative links while blocking unsafe protocols', () => {
    render(
      <MarkdownRenderer content={'[Jump](#heading) [Relative](./post) [Bad](javascript:alert)'} />,
    )
    expect(screen.getByRole('link', { name: 'Jump' })).toHaveAttribute('href', '#heading')
    expect(screen.getByRole('link', { name: 'Jump' })).not.toHaveAttribute('target')
    expect(screen.getByRole('link', { name: 'Relative' })).toHaveAttribute('href', './post')
    expect(screen.queryByRole('link', { name: 'Bad' })).not.toBeInTheDocument()
  })
})
