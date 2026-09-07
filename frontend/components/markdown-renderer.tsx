import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Image from 'next/image'
import Link from 'next/link'
import { cn } from '@/lib/utils'

interface MarkdownRendererProps {
  content: string
}

// Sanitize URLs to prevent XSS attacks
function sanitizeUrl(url: string): string | null {
  if (!url || typeof url !== 'string') {
    return null
  }

  // Remove any whitespace
  url = url.trim()

  // Allow only safe protocols
  const allowedProtocols = ['http:', 'https:', 'mailto:', 'tel:']
  const isRelativeUrl = !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url) && !url.startsWith('//')

  if (isRelativeUrl) {
    return url
  }

  try {
    const urlObj = new URL(url)
    if (!allowedProtocols.includes(urlObj.protocol.toLowerCase())) {
      console.warn(`[MarkdownRenderer] Blocked potentially unsafe URL protocol: ${urlObj.protocol}`)
      return null
    }
    return url
  } catch {
    console.warn(`[MarkdownRenderer] Invalid URL format: ${url}`)
    return null
  }
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Headings
        h1: ({ children }) => <h1 className="text-3xl font-bold mb-4 mt-6">{children}</h1>,
        h2: ({ children }) => <h2 className="text-2xl font-bold mb-3 mt-5">{children}</h2>,
        h3: ({ children }) => <h3 className="text-xl font-bold mb-2 mt-4">{children}</h3>,
        h4: ({ children }) => <h4 className="text-lg font-bold mb-2 mt-4">{children}</h4>,

        // Paragraphs
        p: ({ children }) => <p className="mb-4">{children}</p>,

        // Lists
        ul: ({ node: _node, ...props }) => (
          <ul className="list-disc list-outside ml-6 my-4 space-y-2 text-foreground" {...props} />
        ),
        ol: ({ node: _node, ...props }) => (
          <ol
            className="list-decimal list-outside ml-6 my-4 space-y-2 text-foreground"
            {...props}
          />
        ),
        li: ({ node: _node, ...props }) => <li className="leading-relaxed" {...props} />,

        // Blockquote
        blockquote: ({ node: _node, ...props }) => (
          <blockquote
            className="border-l-4 border-primary pl-4 py-1 my-6 italic text-muted-foreground bg-muted/50 rounded-r"
            {...props}
          />
        ),

        // Horizontal rule
        hr: () => (
          <div className="relative group my-6 rounded-lg overflow-hidden border border-border/30" />
        ),

        // Code blocks
        pre: ({ node: _node, className, ...props }) => (
          <pre
            className={cn(
              'bg-muted p-4 rounded-md overflow-x-auto my-4 text-sm [&>code]:bg-transparent [&>code]:p-0',
              className,
            )}
            {...props}
          />
        ),
        code: ({ node: _node, className, ...props }) => (
          <code
            className={cn(
              'bg-muted text-foreground px-1 py-0.5 rounded font-mono text-sm',
              className,
            )}
            {...props}
          />
        ),

        // Links
        a: ({ href, children, node: _node, ...props }) => {
          if (!href) {
            return <span className="text-primary">{children}</span>
          }

          const sanitizedHref = sanitizeUrl(href)
          if (!sanitizedHref) {
            console.warn(`[MarkdownRenderer] Blocked or invalid hyperlink URL: ${href}`)
            return <span className="text-primary">{children}</span>
          }

          const isInternal = !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(sanitizedHref)

          if (isInternal) {
            return (
              <Link
                href={sanitizedHref}
                className="text-primary hover:underline underline-offset-4 transition-colors"
                {...props}
              >
                {children}
              </Link>
            )
          }

          return (
            <a
              href={sanitizedHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline underline-offset-4 transition-colors"
              {...props}
            >
              {children}
            </a>
          )
        },

        // Images
        img: ({ src, alt, title, node: _node }) => {
          if (!src) {
            return null
          }

          const sanitizedSrc = sanitizeUrl(src as string)
          if (!sanitizedSrc) {
            console.warn(`[MarkdownRenderer] Blocked or invalid image URL: ${src}`)
            return null
          }

          return (
            <span className="my-4 block">
              <Image
                src={sanitizedSrc}
                alt={alt || 'Image'}
                width={800}
                height={450}
                className="rounded-md"
              />
              {title && <span className="block text-sm text-muted-foreground mt-1">{title}</span>}
            </span>
          )
        },
      }}
    >
      {content}
    </ReactMarkdown>
  )
}
