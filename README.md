# Jonathan Segovia's Portfolio

A personal portfolio site with an integrated AI "Ask Me Anything" page and a simple blog.

## Features

- **Terminal-inspired Design**: Dark theme with monospace font and terminal-like UI elements
- **Responsive Layout**: Works on all device sizes
- **Content Management**: File-based content using JSON and Markdown
- **Static Site Generation**: Fast loading with Next.js SSG and ISR fallback
- **AI Chatbot**: "Ask Me Anything" page with streaming responses
- **Blog**: Content-rich blog with reading time estimates
- **Projects Showcase**: Display portfolio projects in a responsive grid
- **Career Timeline**: Visual representation of professional experience

## Tech Stack

- **Framework**: Next.js 15+ (App Router) with TypeScript
- **Styling**: Tailwind CSS
- **Content**: JSON files and Markdown blog posts with SSG and ISR (24h revalidation)
- **Deployment**: Vercel with GitHub Actions CI/CD
- **AI**: Vercel AI SDK

## Getting Started

### Prerequisites

- Node.js 15+ and npm/yarn/pnpm
- Vercel account (optional for deployment)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/segovia-dev/segov-dev-front-end.git
   cd segov-dev-front-end
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

3. Set up environment variables:
   Create a `.env.local` file in the root directory with the following variables:
   ```
   # Vertex AI configuration
   VERTEX_AI_PROJECT_ID=your-gcp-project-id
   VERTEX_AI_LOCATION=us-central1
   VERTEX_AI_ENDPOINT_ID=your-endpoint-id
   LLM_MODEL_ID=qwen3-8b-vllm
   
   # Google Cloud service account JSON (for authentication)
   GOOGLE_APPLICATION_CREDENTIALS_JSON='{"type":"service_account",...}'
   ```

4. Run the development server:
   ```bash
   pnpm dev
   ```

5. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

```
├── app/                    # Next.js app router pages
│   ├── api/                # API routes (preview, AMA)
│   ├── blog/               # Blog pages
│   ├── projects/           # Projects pages
│   ├── about/              # About page
│   ├── ama/                # Ask Me Anything page
│   └── components/         # Page-specific components
├── components/             # Shared React components
├── data/                   # Content files (JSON and Markdown)
│   ├── about.json          # About me content
│   ├── career.json         # Career entries
│   ├── projects.json       # Project entries
│   └── blog/               # Blog posts (Markdown files)
├── lib/                    # Utility functions and API clients
│   ├── content.ts          # File-based content loading
│   └── utils.ts            # Utility functions
├── public/                 # Static assets
├── styles/                 # Global CSS and Tailwind configuration
└── types/                  # TypeScript type definitions
```

## Local Development Guide

### Content Management

Content is managed through files in the `data/` directory:
- `data/about.json` - About me description
- `data/career.json` - Career timeline entries
- `data/projects.json` - Project portfolio entries
- `data/blog/*.md` - Blog posts as Markdown files with frontmatter

Blog posts should follow this format:
```markdown
---
title: "Post Title"
slug: "post-slug"
publishedDate: "2024-01-15"
excerpt: "Post excerpt"
coverImage: "/blog-images/cover.jpg"
---

# Post Content
Markdown content here...
```

## License

This project is licensed under the MIT License - see the LICENSE file for details.
