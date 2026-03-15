import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get, has } from '@vercel/edge-config'
import { getAboutMe, getCareerEntries, getProjects, type SiteContent } from '@/lib/content'

vi.mock('@vercel/edge-config', () => ({
  get: vi.fn(),
  has: vi.fn(),
}))

const getEdgeConfigMock = vi.mocked(get)
const hasEdgeConfigMock = vi.mocked(has)

const siteContentFixture: SiteContent = {
  about: {
    description: 'About copy from Edge Config',
  },
  career: [
    {
      title: 'Software Engineer',
      companyName: 'Example Co',
      startDate: '2024-01-01',
      endDate: null,
      description: 'Built things.',
      skills: ['TypeScript', 'AWS'],
    },
  ],
  projects: [
    {
      name: 'segov.dev',
      description: 'Portfolio site',
      skills: ['Next.js', 'React'],
      githubUrl: 'https://github.com/jsegov/segov-dev',
      websiteUrl: 'https://segov.dev',
    },
  ],
}

describe('content loaders backed by Edge Config', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.EDGE_CONFIG = 'https://edge-config.example'
    hasEdgeConfigMock.mockResolvedValue(true)
    getEdgeConfigMock.mockResolvedValue(siteContentFixture)
  })

  it('returns about content from the siteContent payload', async () => {
    await expect(getAboutMe()).resolves.toEqual(siteContentFixture.about)
    expect(hasEdgeConfigMock).toHaveBeenCalledWith('siteContent')
    expect(getEdgeConfigMock).toHaveBeenCalledWith('siteContent')
  })

  it('returns career entries from the siteContent payload', async () => {
    await expect(getCareerEntries()).resolves.toEqual(siteContentFixture.career)
  })

  it('returns projects from the siteContent payload', async () => {
    await expect(getProjects()).resolves.toEqual(siteContentFixture.projects)
  })

  it('throws when EDGE_CONFIG is missing', async () => {
    delete process.env.EDGE_CONFIG

    await expect(getAboutMe()).rejects.toThrow(
      'EDGE_CONFIG env var is required to load site content',
    )
    expect(hasEdgeConfigMock).not.toHaveBeenCalled()
    expect(getEdgeConfigMock).not.toHaveBeenCalled()
  })

  it('throws when the siteContent key is missing', async () => {
    hasEdgeConfigMock.mockResolvedValueOnce(false)

    await expect(getAboutMe()).rejects.toThrow('Edge Config key "siteContent" is missing')
    expect(getEdgeConfigMock).not.toHaveBeenCalled()
  })

  it('throws when the siteContent payload is invalid', async () => {
    getEdgeConfigMock.mockResolvedValueOnce({
      about: {},
      career: [],
      projects: [],
    })

    await expect(getAboutMe()).rejects.toThrow('Edge Config key "siteContent" has invalid shape')
  })
})
