# AGENTS.md

A guide for AI coding agents working on segov-dev.

## Project Overview

This is a Next.js 15 portfolio site with TypeScript strict mode, Tailwind CSS, Contentful CMS integration, and Vercel AI SDK. The site features a terminal-inspired design, blog functionality, and an "Ask Me Anything" chatbot page.

## Setup Commands

Install dependencies:
```bash
pnpm install
```

Start development server:
```bash
pnpm dev
```

Build for production:
```bash
pnpm build
```

Start production server:
```bash
pnpm start
```

Run linting:
```bash
pnpm lint
```

Run tests:
```bash
pnpm test
```

Run tests in watch mode:
```bash
pnpm test:watch
```

Run tests with coverage:
```bash
pnpm coverage
```

Format code:
```bash
pnpm format
```

## Environment Variables

Create a `.env.local` file in the root directory with these variables:

- `CONTENTFUL_SPACE_ID` - Your Contentful space ID
- `CONTENTFUL_ACCESS_TOKEN` - Contentful access token for published content
- `CONTENTFUL_PREVIEW_ACCESS_TOKEN` - Contentful preview token for draft content
- `CONTENTFUL_PREVIEW_SECRET` - Secret for Contentful preview mode
- `CONTENTFUL_ENVIRONMENT` - Contentful environment (default: "master")
- `OPENAI_API_KEY` - OpenAI API key for the AMA chatbot (or any non-empty value when using the self-hosted endpoint)
- `OPENAI_BASE_URL` - (Optional) Custom OpenAI-compatible API endpoint (e.g., your GKE vLLM service)
- `LLM_MODEL_ID` - (Optional) Model ID to use (defaults to "Qwen/Qwen3-8B-FP8" when OPENAI_BASE_URL is set, otherwise "gpt-4o")

**Never commit `.env.local` or any `.env*` files to version control.**

## Code Style

- **TypeScript**: Strict mode enabled
- **Quotes**: Single quotes only
- **Semicolons**: Never use semicolons
- **Prettier**: Configured for consistent formatting
- **ESLint**: Next.js core web vitals + Prettier integration

Always run `pnpm lint` before committing. The formatter will automatically fix many style issues.

## Testing Instructions

This project uses Vitest with happy-dom and React Testing Library.

Run all tests:
```bash
pnpm test
```

Run tests in watch mode (for development):
```bash
pnpm test:watch
```

Run specific test file:
```bash
pnpm vitest run tests/components/button.test.tsx
```

Run tests with coverage:
```bash
pnpm coverage
```

Write tests for components in the `tests/` directory mirroring the `components/` structure. Use React Testing Library queries and matchers from `@testing-library/jest-dom`.

## Development Workflow

1. **Start working**: Run `pnpm install` first to ensure dependencies are up to date
2. **Start dev server**: Run `pnpm dev` to start the development server on http://localhost:3000
3. **Make changes**: Edit files and let hot reload handle updates
4. **Test locally**: Use `pnpm test:watch` to keep tests running during development
5. **Before committing**: Always run `pnpm lint` and `pnpm test` to ensure code quality

## Pull Request Guidelines

- Run `pnpm lint` and fix any linting errors
- Run `pnpm test` and ensure all tests pass
- Write tests for new features or components
- Update documentation if adding new features
- Keep commits focused and well-described

## Agent Notes

- This file is located at the root; it applies to the entire project
- If subprojects are added later, place nested `AGENTS.md` files in subdirectories
- The closest `AGENTS.md` to any edited file takes precedence
- Explicit user prompts override any instructions in this file
- The agent will attempt to run testing commands listed above when making changes
