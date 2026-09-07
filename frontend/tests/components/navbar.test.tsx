import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Navbar } from '@/components/navbar'

vi.mock('next/navigation', () => ({ usePathname: () => '/ama' }))
vi.mock('@/components/theme-toggle', () => ({ ThemeToggle: () => null }))

afterEach(cleanup)

describe('mobile navigation', () => {
  it('exposes its expanded state and restores focus when Escape closes it', () => {
    render(<Navbar />)
    const toggle = screen.getByRole('button', { name: 'Toggle navigation' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const menu = document.getElementById(toggle.getAttribute('aria-controls')!)!
    const currentPage = within(menu).getByRole('link', { name: 'AMA' })
    expect(currentPage).toHaveAttribute('aria-current', 'page')
    currentPage.focus()
    fireEvent.keyDown(currentPage, { key: 'Escape' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveFocus()
    expect(menu).not.toBeInTheDocument()
  })
})
