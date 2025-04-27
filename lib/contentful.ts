import { createClient } from "contentful"

// Check if required environment variables are available
const requiredEnvVars = {
  spaceId: process.env.CONTENTFUL_SPACE_ID,
  accessToken: process.env.CONTENTFUL_ACCESS_TOKEN,
  previewToken: process.env.CONTENTFUL_PREVIEW_ACCESS_TOKEN,
}

// Validate environment variables
const validateEnv = () => {
  const missing = Object.entries(requiredEnvVars)
    .filter(([_, value]) => !value)
    .map(([key]) => key)

  if (missing.length > 0) {
    console.error(`Missing required Contentful environment variables: ${missing.join(", ")}`)
    return false
  }

  return true
}

// Initialize Contentful client with proper error handling
export const client = validateEnv()
  ? createClient({
      space: process.env.CONTENTFUL_SPACE_ID!,
      accessToken: process.env.CONTENTFUL_ACCESS_TOKEN!,
      environment: process.env.CONTENTFUL_ENVIRONMENT || "master",
    })
  : null

// Preview client for draft content
export const previewClient =
  validateEnv() && process.env.CONTENTFUL_PREVIEW_ACCESS_TOKEN
    ? createClient({
        space: process.env.CONTENTFUL_SPACE_ID!,
        accessToken: process.env.CONTENTFUL_PREVIEW_ACCESS_TOKEN!,
        environment: process.env.CONTENTFUL_ENVIRONMENT || "master",
        host: "preview.contentful.com",
      })
    : null

// Get the appropriate client based on preview mode
export const getClient = (preview = false) => {
  if (!validateEnv()) {
    throw new Error("Contentful environment variables are not properly configured")
  }

  const selectedClient = preview && previewClient ? previewClient : client
  return selectedClient
}

// Types for Contentful content
export interface AboutMeEntry {
  description: string
}
export interface CareerEntry {
  title: string
  companyName: string
  startDate: string
  endDate: string | null
  description: string
  skills: string[]
}

export interface ProjectEntry {
  name: string
  description: string
  skills: string[]
  githubUrl: string
}

export interface BlogPost {
  title: string
  slug: string
  publishedDate: string
  excerpt: string
  coverImage: {
    url: string
  }
  bodyRichText: any
}

/**
 * Fetch a specific entry by ID
 * This allows direct access to any entry regardless of content type
 */
export async function getEntryById(entryId: string, preview = false): Promise<any> {
  try {
    const client = getClient(preview)
    if (!client) {
      return null
    }

    const entry = await client.getEntry(entryId)
    return entry
  } catch (error) {
    console.error(`Error fetching entry with ID "${entryId}"`, error)
    return null
  }
}

// Fetch career entries
export async function getCareerEntries(preview = false): Promise<CareerEntry[]> {
  try {
    const client = getClient(preview)
    if (!client) {
      return []
    }

    const queryParams = {
      content_type: "careerEntry",
      order: "-fields.startDate",
    }

    const entries = await client.getEntries(queryParams)

    // Map and validate entries
    const mappedEntries = entries.items.map((item: any) => {
      try {
        return {
          title: item.fields.title,
          companyName: item.fields.companyName,
          startDate: item.fields.startDate,
          endDate: item.fields.endDate || null,
          description: item.fields.description,
          skills: item.fields.skills || [],
        }
      } catch (error) {
        // Return a minimal valid entry to prevent breaking the UI
        return {
          title: item.fields?.title || "Untitled Entry",
          companyName: item.fields?.companyName || "Unknown Company",
          startDate: item.fields?.startDate || new Date().toISOString(),
          endDate: null,
          description: item.fields?.description || "No description available",
          skills: [],
        }
      }
    })

    return mappedEntries
  } catch (error) {
    console.error("Error fetching career entries", error)
    return []
  }
}

// Fetch project entries
export async function getProjects(preview = false): Promise<ProjectEntry[]> {
  try {
    const client = getClient(preview)
    if (!client) {
      return []
    }

    const queryParams = {
      content_type: "projectEntry",
      order: "-sys.createdAt",
    }

    const entries = await client.getEntries(queryParams)

    const mappedEntries = entries.items.map((item: any) => {
      try {
        return {
          name: item.fields.name || item.fields.title || "Untitled Project",
          description: item.fields.description || "No description available",
          skills: item.fields.skills || item.fields.technologies || [],
          githubUrl: item.fields.githubUrl || ""
        }
      } catch (error) {
        // Return a minimal valid entry
        return {
          name: "Untitled Project",
          description: "No description available",
          skills: [],
          githubUrl: ""
        }
      }
    })

    return mappedEntries
  } catch (error) {
    console.error("Error fetching project entries", error)
    return []
  }
}

// Fetch blog posts
export async function getBlogPosts(preview = false): Promise<BlogPost[]> {
  try {
    const client = getClient(preview)
    if (!client) {
      return []
    }

    const queryParams = {
      content_type: "blogPost",
      order: "-fields.publishedDate",
    }

    const entries = await client.getEntries(queryParams)

    const mappedEntries = entries.items.map((item: any, index: number) => {
      try {
        return {
          title: item.fields.title,
          slug: item.fields.slug,
          publishedDate: item.fields.publishedDate,
          excerpt: item.fields.excerpt,
          coverImage: {
            url: item.fields.coverImage?.fields?.file?.url
              ? `https:${item.fields.coverImage.fields.file.url}`
              : "/placeholder.svg?height=600&width=800",
          },
          bodyRichText: item.fields.bodyRichText,
        }
      } catch (error) {
        // Return a minimal valid entry
        return {
          title: item.fields?.title || "Untitled Post",
          slug: item.fields?.slug || `untitled-post-${index}`,
          publishedDate: item.fields?.publishedDate || new Date().toISOString(),
          excerpt: item.fields?.excerpt || "No excerpt available",
          coverImage: {
            url: "/placeholder.svg?height=600&width=800",
          },
          bodyRichText: {},
        }
      }
    })

    return mappedEntries
  } catch (error) {
    console.error("Error fetching blog posts", error)
    return []
  }
}

// Fetch a single blog post by slug
export async function getBlogPostBySlug(slug: string, preview = false): Promise<BlogPost | null> {
  try {
    const client = getClient(preview)
    if (!client) {
      return null
    }

    const queryParams = {
      content_type: "blogPost",
      "fields.slug": slug,
      limit: 1,
    }

    const entries = await client.getEntries(queryParams)

    if (!entries.items.length) {
      return null
    }

    const item = entries.items[0] as any

    return {
      title: item.fields.title,
      slug: item.fields.slug,
      publishedDate: item.fields.publishedDate,
      excerpt: item.fields.excerpt,
      coverImage: {
        url: item.fields.coverImage?.fields?.file?.url
          ? `https:${item.fields.coverImage.fields.file.url}`
          : "/placeholder.svg?height=600&width=800",
      },
      bodyRichText: item.fields.bodyRichText,
    }
  } catch (error) {
    console.error(`Error fetching blog post with slug "${slug}"`, error)
    return null
  }
}

// Fetch all blog post slugs for static paths
export async function getAllBlogSlugs(): Promise<string[]> {
  try {
    const client = getClient()
    if (!client) {
      return []
    }

    const queryParams = {
      content_type: "blogPost",
      select: "fields.slug",
    }

    const entries = await client.getEntries(queryParams)
    const slugs = entries.items.map((item: any) => item.fields.slug)

    return slugs
  } catch (error) {
    console.error("Error fetching all blog slugs", error)
    return []
  }
}

// Fetch about me content
export async function getAboutMe(preview = false): Promise<AboutMeEntry | null> {
  try {
    const client = getClient(preview)
    if (!client) {
      return null
    }

    const queryParams = {
      content_type: "aboutMe",
      limit: 1,
    }

    const entries = await client.getEntries(queryParams)

    if (!entries.items.length) {
      return null
    }

    return {
      description: entries.items[0].fields.description as string,
    }
  } catch (error) {
    console.error("Error fetching about me content", error)
    return null
  }
}
