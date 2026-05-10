import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const { connectionMock, getAboutMeMock, getCareerEntriesMock, getProjectsMock } = vi.hoisted(
  () => ({
    connectionMock: vi.fn(),
    getAboutMeMock: vi.fn(),
    getCareerEntriesMock: vi.fn(),
    getProjectsMock: vi.fn(),
  }),
)

vi.mock('next/server', () => ({
  connection: connectionMock,
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('@/components/navbar', () => ({
  Navbar: () => <div data-testid="navbar" />,
}))

vi.mock('@/lib/content', () => ({
  getAboutMe: getAboutMeMock,
  getCareerEntries: getCareerEntriesMock,
  getProjects: getProjectsMock,
}))

import Home from '@/app/page'
import CareerPage from '@/app/career/page'
import ProjectsPage from '@/app/projects/page'

describe('pages backed by Edge Config content', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectionMock.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders about copy on the home page', async () => {
    getAboutMeMock.mockResolvedValueOnce({
      description: 'About copy from Edge Config',
    })

    render(await Home())

    expect(screen.getByText('About copy from Edge Config')).toBeInTheDocument()
    expect(connectionMock).toHaveBeenCalled()
  })

  it('renders the home page error state when about content fails', async () => {
    getAboutMeMock.mockRejectedValueOnce(new Error('missing site content'))

    render(await Home())

    expect(screen.getByText('Failed to load about data.')).toBeInTheDocument()
  })

  it('renders career entries from Edge Config', async () => {
    getCareerEntriesMock.mockResolvedValueOnce([
      {
        title: 'Software Engineer',
        companyName: 'Example Co',
        startDate: '2024-01-01',
        endDate: null,
        description: 'Built systems.',
        skills: ['TypeScript', 'AWS'],
      },
    ])

    render(await CareerPage())

    expect(screen.getByText('Software Engineer')).toBeInTheDocument()
    expect(screen.getByText('Example Co')).toBeInTheDocument()
    expect(screen.getByText('Built systems.')).toBeInTheDocument()
  })

  it('renders the career page error state when content fails', async () => {
    getCareerEntriesMock.mockRejectedValueOnce(new Error('bad edge config'))

    render(await CareerPage())

    expect(screen.getByText('Failed to load career data.')).toBeInTheDocument()
  })

  it('renders projects from Edge Config', async () => {
    getProjectsMock.mockResolvedValueOnce([
      {
        name: 'segov.dev',
        description: 'Portfolio site',
        skills: ['Next.js', 'React'],
        githubUrl: 'https://github.com/jsegov/segov-dev',
        websiteUrl: 'https://segov.dev',
      },
    ])

    render(await ProjectsPage())

    expect(screen.getByText('segov.dev')).toBeInTheDocument()
    expect(screen.getByText('Portfolio site')).toBeInTheDocument()
    expect(screen.getByText('View Website')).toBeInTheDocument()
    expect(screen.getByText('View on GitHub')).toBeInTheDocument()
  })

  it('renders the projects page error state when content fails', async () => {
    getProjectsMock.mockRejectedValueOnce(new Error('bad edge config'))

    render(await ProjectsPage())

    expect(screen.getByText('Failed to load project data.')).toBeInTheDocument()
  })
})
