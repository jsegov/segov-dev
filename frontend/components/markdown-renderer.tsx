import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Image from 'next/image'
import Link from 'next/link'

interface MarkdownRendererProps {
  content: string
}

// Sanitize URLs to prevent XSS attacks
function sanitizeUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null

  // Remove any whitespace
  url = url.trim()

  // Allow only safe protocols
  const allowedProtocols = ['http:', 'https:', 'mailto:', 'tel:']
  const isRelativeUrl = url.startsWith('/') || url.startsWith('./') || url.startsWith('../')

  if (isRelativeUrl) {
    return url // Relative URLs are generally safe
  }

  try {
    const urlObj = new URL(url)
    if (!allowedProtocols.includes(urlObj.protocol.toLowerCase())) {
      console.warn(`[MarkdownRenderer] Blocked potentially unsafe URL protocol: ${urlObj.protocol}`)
      return null
    }
    return url
  } catch (error) {
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
        ul: ({ children }) => <ul className="list-disc list-inside mb-4 ml-4">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside mb-4 ml-4">{children}</ol>,
        li: ({ children }) => <li className="mb-1">{children}</li>,

        // Blockquote
        blockquote: ({ children }) => (
          <blockquote className="border-l-4 border-terminal-green pl-4 italic my-4">{children}</blockquote>
        ),

        // Horizontal rule
        hr: () => <hr className="my-6 border-terminal-green/30" />,

        // Code blocks
        code: ({ className, children, ...props }) => {
          const isInline = !className
          if (isInline) {
            return (
              <code className="bg-terminal-black/30 px-1 py-0.5 rounded font-mono text-sm" {...props}>
                {children}
              </code>
            )
          }
          return (
            <pre className="bg-terminal-black/30 p-4 rounded-md overflow-x-auto my-4 text-sm">
              <code {...props}>{children}</code>
            </pre>
          )
        },

        // Links
        a: ({ href, children }) => {
          if (!href) {
            return <span className="text-terminal-green">{children}</span>
          }

          const sanitizedHref = sanitizeUrl(href)
          if (!sanitizedHref) {
            console.warn(`[MarkdownRenderer] Blocked or invalid hyperlink URL: ${href}`)
            return <span className="text-terminal-green">{children}</span>
          }

          const isInternal = sanitizedHref.startsWith('/')

          if (isInternal) {
            return (
              <Link href={sanitizedHref} className="text-terminal-green underline hover:text-white">
                {children}
              </Link>
            )
          }

          return (
            <a
              href={sanitizedHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-terminal-green underline hover:text-white"
            >
              {children}
            </a>
          )
        },

        // Images
        img: ({ src, alt, title }) => {
          if (!src) return null

          const sanitizedSrc = sanitizeUrl(src)
          if (!sanitizedSrc) {
            console.warn(`[MarkdownRenderer] Blocked or invalid image URL: ${src}`)
            return null
          }

          // Handle relative paths for images
          const imageSrc = sanitizedSrc.startsWith('http') ? sanitizedSrc : sanitizedSrc

          return (
            <div className="my-4">
              <Image
                src={imageSrc}
                alt={alt || 'Image'}
                width={800}
                height={450}
                className="rounded-md"
              />
              {title && <p className="text-sm text-terminal-green/70 mt-1">{title}</p>}
            </div>
          )
        },
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

