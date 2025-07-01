import type React from "react"
import { documentToReactComponents } from "@contentful/rich-text-react-renderer"
import { BLOCKS, INLINES, MARKS } from "@contentful/rich-text-types"
import Image from "next/image"
import Link from "next/link"

interface RichTextRendererProps {
  content: any
}

// Sanitize URLs to prevent XSS attacks
function sanitizeUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  
  // Remove any whitespace
  url = url.trim();
  
  // Allow only safe protocols
  const allowedProtocols = ['http:', 'https:', 'mailto:', 'tel:'];
  const isRelativeUrl = url.startsWith('/') || url.startsWith('./') || url.startsWith('../');
  
  if (isRelativeUrl) {
    return url; // Relative URLs are generally safe
  }
  
  try {
    const urlObj = new URL(url);
    if (!allowedProtocols.includes(urlObj.protocol.toLowerCase())) {
      console.warn(`[RichTextRenderer] Blocked potentially unsafe URL protocol: ${urlObj.protocol}`);
      return null;
    }
    return url;
  } catch (error) {
    console.warn(`[RichTextRenderer] Invalid URL format: ${url}`);
    return null;
  }
}

export function RichTextRenderer({ content }: RichTextRendererProps) {
  const options = {
    renderMark: {
      [MARKS.BOLD]: (text: React.ReactNode) => <strong className="font-bold">{text}</strong>,
      [MARKS.ITALIC]: (text: React.ReactNode) => <em className="italic">{text}</em>,
      [MARKS.CODE]: (text: React.ReactNode) => (
        <code className="bg-terminal-black/30 px-1 py-0.5 rounded font-mono text-sm">{text}</code>
      ),
    },
    renderNode: {
      [BLOCKS.PARAGRAPH]: (node: any, children: React.ReactNode) => <p className="mb-4">{children}</p>,
      [BLOCKS.HEADING_1]: (node: any, children: React.ReactNode) => (
        <h1 className="text-3xl font-bold mb-4 mt-6">{children}</h1>
      ),
      [BLOCKS.HEADING_2]: (node: any, children: React.ReactNode) => (
        <h2 className="text-2xl font-bold mb-3 mt-5">{children}</h2>
      ),
      [BLOCKS.HEADING_3]: (node: any, children: React.ReactNode) => (
        <h3 className="text-xl font-bold mb-2 mt-4">{children}</h3>
      ),
      [BLOCKS.HEADING_4]: (node: any, children: React.ReactNode) => (
        <h4 className="text-lg font-bold mb-2 mt-4">{children}</h4>
      ),
      [BLOCKS.UL_LIST]: (node: any, children: React.ReactNode) => (
        <ul className="list-disc list-inside mb-4 ml-4">{children}</ul>
      ),
      [BLOCKS.OL_LIST]: (node: any, children: React.ReactNode) => (
        <ol className="list-decimal list-inside mb-4 ml-4">{children}</ol>
      ),
      [BLOCKS.LIST_ITEM]: (node: any, children: React.ReactNode) => <li className="mb-1">{children}</li>,
      [BLOCKS.QUOTE]: (node: any, children: React.ReactNode) => (
        <blockquote className="border-l-4 border-terminal-green pl-4 italic my-4">{children}</blockquote>
      ),
      [BLOCKS.HR]: () => <hr className="my-6 border-terminal-green/30" />,
      [BLOCKS.EMBEDDED_ASSET]: (node: any) => {
        const { title, description, file } = node.data.target.fields
        const rawUrl = file?.url ? `https:${file.url}` : null
        const url = rawUrl ? sanitizeUrl(rawUrl) : null

        if (!url) {
          console.warn(`[RichTextRenderer] Blocked or invalid embedded asset URL: ${rawUrl}`);
          return null;
        }

        if (file.contentType.includes("image")) {
          return (
            <div className="my-4">
              <Image
                src={url || "/placeholder.svg"}
                alt={description || title || "Embedded image"}
                width={800}
                height={450}
                className="rounded-md"
              />
              {title && <p className="text-sm text-terminal-green/70 mt-1">{title}</p>}
            </div>
          )
        }

        return (
          <div className="my-4">
            <a href={url} target="_blank" rel="noopener noreferrer" className="text-terminal-green underline">
              {title || "Download file"}
            </a>
          </div>
        )
      },
      [INLINES.HYPERLINK]: (node: any, children: React.ReactNode) => {
        const { uri } = node.data
        const sanitizedUri = sanitizeUrl(uri)

        if (!sanitizedUri) {
          console.warn(`[RichTextRenderer] Blocked or invalid hyperlink URL: ${uri}`);
          // Return children as plain text instead of a link
          return <span className="text-terminal-green">{children}</span>
        }

        const isInternal = sanitizedUri.startsWith("/")

        if (isInternal) {
          return (
            <Link href={sanitizedUri} className="text-terminal-green underline hover:text-white">
              {children}
            </Link>
          )
        }

        return (
          <a
            href={sanitizedUri}
            target="_blank"
            rel="noopener noreferrer"
            className="text-terminal-green underline hover:text-white"
          >
            {children}
          </a>
        )
      },
      [BLOCKS.CODE]: (node: any) => {
        return (
          <pre className="bg-terminal-black/30 p-4 rounded-md overflow-x-auto my-4 text-sm">
            <code>{node.content[0].value}</code>
          </pre>
        )
      },
    },
  }

  return <>{documentToReactComponents(content, options)}</>
}
