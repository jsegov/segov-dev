import type { Metadata } from "next"
import Image from "next/image"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Navbar } from "@/components/navbar"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { getBlogPostBySlug, getAllBlogSlugs } from "@/lib/content"
import { format } from "date-fns"

export const revalidate = 86400 // Revalidate every 24 hours

export async function generateStaticParams() {
  const slugs = await getAllBlogSlugs()
  return slugs.map((slug) => ({ slug }))
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const post = await getBlogPostBySlug(params.slug)

  if (!post) {
    return {
      title: "Post Not Found | Jonathan Segovia",
    }
  }

  return {
    title: `${post.title} | Blog | Jonathan Segovia`,
    description: post.excerpt,
  }
}

function calculateReadingTime(content: string): number {
  // Count words in markdown content
  const wordCount = content.split(/\s+/).length
  const readingTime = Math.ceil(wordCount / 200) // Assuming 200 words per minute
  return Math.max(1, readingTime) // Minimum 1 minute
}

export default async function BlogPostPage({ params }: { params: { slug: string } }) {
  const post = await getBlogPostBySlug(params.slug)

  if (!post) {
    notFound()
  }

  const publishedDate = new Date(post.publishedDate)
  const readingTime = calculateReadingTime(post.bodyMarkdown)

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <div className="container mx-auto px-4 py-12">
        <div className="terminal-container max-w-4xl mx-auto">
          <div className="mb-6">
            <Link href="/blog" className="inline-flex items-center text-muted-foreground hover:text-foreground mb-6 transition-colors">
              <span>← Back to Blog</span>
            </Link>
          </div>

          <article>
            <h1 className="text-3xl font-bold mb-4">{post.title}</h1>

            <div className="flex items-center text-sm text-muted-foreground mb-8 space-x-4 pb-4 border-b border-border/30">
              <span>{format(publishedDate, "MMMM d, yyyy")}</span>
              <span className="mx-2">•</span>
              <span>{readingTime} min read</span>
            </div>

            <div className="relative aspect-video mb-8 overflow-hidden rounded">
              <Image src={post.coverImage.url || "/placeholder.svg"} alt={post.title} fill className="object-cover" />
            </div>

            <div className="prose prose-invert max-w-none">
              <MarkdownRenderer content={post.content} />
            </div>
          </article>
        </div>
      </div>
    </div>
  )
}
