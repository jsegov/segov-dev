import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'

// Path to data directory
const dataDirectory = path.join(process.cwd(), 'data')

// Types for content
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
  content: string // Markdown content
  bodyMarkdown: string // Raw markdown for reading time calculation
}

// Fetch about me content
export async function getAboutMe(): Promise<AboutMeEntry | null> {
  try {
    const filePath = path.join(dataDirectory, 'about.json')
    const fileContents = fs.readFileSync(filePath, 'utf8')
    const data = JSON.parse(fileContents) as AboutMeEntry
    return data
  } catch (error) {
    console.error('Error fetching about me content', error)
    return null
  }
}

// Fetch career entries
export async function getCareerEntries(): Promise<CareerEntry[]> {
  try {
    const filePath = path.join(dataDirectory, 'career.json')
    const fileContents = fs.readFileSync(filePath, 'utf8')
    const data = JSON.parse(fileContents) as CareerEntry[]
    return data
  } catch (error) {
    console.error('Error fetching career entries', error)
    return []
  }
}

// Fetch project entries
export async function getProjects(): Promise<ProjectEntry[]> {
  try {
    const filePath = path.join(dataDirectory, 'projects.json')
    const fileContents = fs.readFileSync(filePath, 'utf8')
    const data = JSON.parse(fileContents) as ProjectEntry[]
    return data
  } catch (error) {
    console.error('Error fetching project entries', error)
    return []
  }
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


