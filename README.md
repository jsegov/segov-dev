# Jonathan Segovia's Portfolio

A personal portfolio site with an integrated AI "Ask Me Anything" page and a simple blog.

## Features

- **Terminal-inspired Design**: Dark theme with monospace font and terminal-like UI elements
- **Responsive Layout**: Works on all device sizes
- **Content Management**: Powered by Contentful CMS
- **Static Site Generation**: Fast loading with Next.js SSG and ISR fallback
- **AI Chatbot**: "Ask Me Anything" page with streaming responses
- **Blog**: Content-rich blog with reading time estimates
- **Projects Showcase**: Display portfolio projects in a responsive grid
- **Career Timeline**: Visual representation of professional experience

## Demo

![Portfolio Screenshot](public/images/portfolio-screenshot.png)

Visit the live site: [jonathansegovia.dev](https://jonathansegovia.dev)

## Tech Stack

- **Framework**: Next.js 14+ (App Router) with TypeScript
- **Styling**: Tailwind CSS
- **Content**: Contentful CMS with SSG and ISR (24h revalidation)
- **Deployment**: Vercel with GitHub Actions CI/CD
- **AI**: OpenAI API with streaming responses

## Getting Started

### Prerequisites

- Node.js 18+ and npm/yarn
- Contentful account
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
   CONTENTFUL_SPACE_ID=your_contentful_space_id
   CONTENTFUL_ACCESS_TOKEN=your_contentful_access_token
   CONTENTFUL_PREVIEW_ACCESS_TOKEN=your_contentful_preview_token
   CONTENTFUL_PREVIEW_SECRET=your_preview_secret
   CONTENTFUL_ENVIRONMENT=master
   OPENAI_API_KEY=your_openai_api_key
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
├── lib/                    # Utility functions and API clients
│   ├── contentful/         # Contentful API integration
│   └── openai/             # OpenAI API integration
├── public/                 # Static assets
├── styles/                 # Global CSS and Tailwind configuration
└── types/                  # TypeScript type definitions
```

## AI Chatbot Implementation

The "Ask Me Anything" page uses:

- **Vercel AI SDK**: Provides streaming UI components and utilizes OpenAI models for generating responses
- **Streaming Responses**: Implements server-sent events for real-time response streaming
- **Context Management**: Maintains conversation history for contextual responses
- **Custom Prompts**: Pre-configured with personal information to answer questions accurately
- **Rate Limiting**: Protects against excessive usage

## Local Development Guide

### Environment Variables Setup

For local development, ensure your `.env.local` file has the correct Contentful credentials:

```
CONTENTFUL_SPACE_ID=your_space_id
CONTENTFUL_ACCESS_TOKEN=your_access_token
CONTENTFUL_ENVIRONMENT=master
```


## License

This project is licensed under the MIT License - see the LICENSE file for details.
