import type { Metadata } from "next"
import Image from "next/image"
import Link from "next/link"
import { Navbar } from "@/components/navbar"
import { getBlogPosts, type BlogPost } from "@/lib/content"
import { format } from "date-fns"

export const metadata: Metadata = {
  title: "Blog | Jonathan Segovia",
  description: "Thoughts, tutorials, and insights from Jonathan Segovia",
}

export const revalidate = 86400 // Revalidate every 24 hours

function calculateReadingTime(content: string): number {
  // Count words in markdown content
  const wordCount = content.split(/\s+/).length
  const readingTime = Math.ceil(wordCount / 200) // Assuming 200 words per minute
  return Math.max(1, readingTime) // Minimum 1 minute
}

// Update the BlogPage component to handle potential errors when fetching data

export default async function BlogPage() {
  let posts: BlogPost[] = []
  let error: string | null = null

  try {
    posts = await getBlogPosts()
  } catch (err) {
    console.error("Failed to fetch blog posts:", err)
    error = "Failed to load blog data."
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <div className="container mx-auto px-4 py-12">
        <div className="terminal-container max-w-4xl mx-auto">
          <div className="terminal-header">
            <h1 className="terminal-title">Blog</h1>
          </div>

          <div className="terminal-line">
            <span className="terminal-command">$ cat blog_posts.md</span>
          </div>

          {error ? (
            <div className="mt-8 p-4 border border-red-500/30 bg-red-500/10 text-red-400 rounded">
              <p>{error}</p>
            </div>
          ) : posts.length === 0 ? (
            <div className="mt-8 p-4 border border-border/30 rounded">
              <p>No blog posts found.</p>
            </div>
          ) : (
            <div className="space-y-8 mt-8">
              {posts.map((post) => {
                const publishedDate = new Date(post.publishedDate)
                const readingTime = calculateReadingTime(post.bodyMarkdown)

                return (
                  <Link key={post.slug} href={`/blog/${post.slug}`} className="card block">
                    <div className="flex flex-col md:flex-row gap-6">
                      <div className="md:w-1/3">
                        <div className="relative aspect-video overflow-hidden rounded">
                          <Image
                            src={post.coverImage.url || "/placeholder.svg?height=600&width=800"}
                            alt={post.title}
                            fill
                            className="object-cover transition-transform hover:scale-105"
                          />
                        </div>
                      </div>

                      <div className="md:w-2/3">
                        <h2 className="text-xl font-bold mb-2">{post.title}</h2>

                        <div className="flex items-center text-muted-foreground/70 mb-3">
                          <span>{format(publishedDate, "MMMM d, yyyy")}</span>
                          <span className="mx-2">•</span>
                          <span>{readingTime} min read</span>
                        </div>

                        <p className="text-muted-foreground/80">{post.excerpt}</p>
                      </div>
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
