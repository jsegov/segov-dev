import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import { get } from '@vercel/edge-config'
import { z } from 'zod'

// Path to data directory
const dataDirectory = path.join(process.cwd(), 'data')

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

export interface BlogPost {
  title: string
  slug: string
  publishedDate: string
  excerpt: string
  coverImage: {
    url: string
  }
  content: string // Markdown content
  bodyMarkdown: string // Raw markdown for reading time calculation
}

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

// Fetch blog posts
export async function getBlogPosts(): Promise<BlogPost[]> {
  try {
    const blogDirectory = path.join(dataDirectory, 'blog')
    const files = fs.readdirSync(blogDirectory)
    const markdownFiles = files.filter((file) => file.endsWith('.md'))

    const posts = markdownFiles
      .map((fileName) => {
        const filePath = path.join(blogDirectory, fileName)
        const fileContents = fs.readFileSync(filePath, 'utf8')
        const { data: frontmatter, content } = matter(fileContents)

        return {
          title: frontmatter.title || 'Untitled Post',
          slug: frontmatter.slug || fileName.replace('.md', ''),
          publishedDate: frontmatter.publishedDate || new Date().toISOString(),
          excerpt: frontmatter.excerpt || 'No excerpt available',
          coverImage: {
            url: frontmatter.coverImage || '/placeholder.svg?height=600&width=800',
          },
          content,
          bodyMarkdown: content,
        } as BlogPost
      })
      .sort((a, b) => {
        // Sort by published date descending
        return new Date(b.publishedDate).getTime() - new Date(a.publishedDate).getTime()
      })

    return posts
  } catch (error) {
    console.error('Error fetching blog posts', error)
    return []
  }
}

// Fetch a single blog post by slug
export async function getBlogPostBySlug(slug: string): Promise<BlogPost | null> {
  try {
    const blogDirectory = path.join(dataDirectory, 'blog')
    const files = fs.readdirSync(blogDirectory)
    const markdownFiles = files.filter((file) => file.endsWith('.md'))

    for (const fileName of markdownFiles) {
      const filePath = path.join(blogDirectory, fileName)
      const fileContents = fs.readFileSync(filePath, 'utf8')
      const { data: frontmatter, content } = matter(fileContents)

      const postSlug = frontmatter.slug || fileName.replace('.md', '')
      if (postSlug === slug) {
        return {
          title: frontmatter.title || 'Untitled Post',
          slug: postSlug,
          publishedDate: frontmatter.publishedDate || new Date().toISOString(),
          excerpt: frontmatter.excerpt || 'No excerpt available',
          coverImage: {
            url: frontmatter.coverImage || '/placeholder.svg?height=600&width=800',
          },
          content,
          bodyMarkdown: content,
        } as BlogPost
      }
    }

    return null
  } catch (error) {
    console.error(`Error fetching blog post with slug "${slug}"`, error)
    return null
  }
}

// Fetch all blog post slugs for static paths
export async function getAllBlogSlugs(): Promise<string[]> {
  try {
    const blogDirectory = path.join(dataDirectory, 'blog')
    const files = fs.readdirSync(blogDirectory)
    const markdownFiles = files.filter((file) => file.endsWith('.md'))

    const slugs = markdownFiles.map((fileName) => {
      const filePath = path.join(blogDirectory, fileName)
      const fileContents = fs.readFileSync(filePath, 'utf8')
      const { data: frontmatter } = matter(fileContents)
      return frontmatter.slug || fileName.replace('.md', '')
    })

    return slugs
  } catch (error) {
    console.error('Error fetching all blog slugs', error)
    return []
  }
}
