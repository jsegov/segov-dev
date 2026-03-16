import { get } from '@vercel/edge-config'
import { z } from 'zod'

const AboutMeEntrySchema = z.object({
  description: z.string(),
})

const CareerEntrySchema = z.object({
  title: z.string(),
  companyName: z.string(),
  startDate: z.string(),
  endDate: z.string().nullable(),
  description: z.string(),
  skills: z.array(z.string()),
})

const ProjectEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  skills: z.array(z.string()),
  githubUrl: z.string().url(),
  websiteUrl: z.string().url().optional(),
})

const SiteContentSchema = z.object({
  about: AboutMeEntrySchema,
  career: z.array(CareerEntrySchema),
  projects: z.array(ProjectEntrySchema),
})

const SITE_CONTENT_KEY = 'siteContent'

// Types for content
export type AboutMeEntry = z.infer<typeof AboutMeEntrySchema>
export type CareerEntry = z.infer<typeof CareerEntrySchema>
export type ProjectEntry = z.infer<typeof ProjectEntrySchema>
export type SiteContent = z.infer<typeof SiteContentSchema>

async function getSiteContent(): Promise<SiteContent> {
  if (!process.env.EDGE_CONFIG) {
    throw new Error('EDGE_CONFIG env var is required to load site content')
  }

  const siteContent = await get(SITE_CONTENT_KEY)
  if (siteContent === undefined) {
    throw new Error(`Edge Config key "${SITE_CONTENT_KEY}" is missing`)
  }

  if (siteContent === null) {
    throw new Error(`Edge Config key "${SITE_CONTENT_KEY}" resolved to null`)
  }

  const parsedContent = SiteContentSchema.safeParse(siteContent)
  if (!parsedContent.success) {
    throw new Error(`Edge Config key "${SITE_CONTENT_KEY}" has invalid shape`, {
      cause: parsedContent.error,
    })
  }

  return parsedContent.data
}

// Fetch about me content
export async function getAboutMe(): Promise<AboutMeEntry> {
  const siteContent = await getSiteContent()
  return siteContent.about
}

// Fetch career entries
export async function getCareerEntries(): Promise<CareerEntry[]> {
  const siteContent = await getSiteContent()
  return siteContent.career
}

// Fetch project entries
export async function getProjects(): Promise<ProjectEntry[]> {
  const siteContent = await getSiteContent()
  return siteContent.projects
}
