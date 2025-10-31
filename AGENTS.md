# AGENTS.md

A guide for AI coding agents working on segov-dev.

## Project Overview

This is a monorepo containing:
- **Frontend**: Next.js 15 portfolio site with TypeScript strict mode, Tailwind CSS, file-based content management (JSON and Markdown), and OpenAI SDK. The site features a terminal-inspired design, blog functionality, and an "Ask Me Anything" chatbot page.
- **Backend**: FastAPI-based MCP server for Vertex AI RAG Engine operations
- **Infrastructure**: Cloud Run deployment configurations

See [docs/monorepo.md](docs/monorepo.md) for detailed structure information.

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

### Frontend (`frontend/.env.local`)

- `VERTEX_AI_PROJECT_ID` - GCP project ID for Vertex AI deployment
- `VERTEX_AI_LOCATION` - Region for Vertex AI (default: `us-central1`)
- `VERTEX_AI_ENDPOINT_ID` - Vertex AI endpoint ID (populated after deployment)
- `LLM_MODEL_ID` - (Optional) Model identifier for API calls (defaults to `qwen3-8b-vllm` or matches `VERTEX_AI_SERVED_NAME`)
- `GOOGLE_APPLICATION_CREDENTIALS_JSON` - Google Cloud service account JSON as string (required for Vertex AI authentication)

### Backend (`backend/.env`)

- `PROJECT_ID` - GCP project ID
- `LOCATION` - Vertex AI region (default: `us-central1`)
- `RAG_CORPUS_NAME` - Full resource name of the RAG corpus
- `PORT` - Server port (default: `8080`)

The frontend constructs the Vertex AI endpoint URL automatically from the project ID, location, and endpoint ID. Authentication is handled server-side using Google OAuth tokens from the service account.

**Never commit `.env.local`, `.env`, or any `.env*` files to version control.**

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
2. **Start dev servers**: 
   - Run `pnpm dev` to start all development servers
   - Or run `pnpm --filter frontend dev` for frontend only (http://localhost:3000)
   - Or run `uvicorn app.main:app --reload` from `backend/` for backend only (http://localhost:8080)
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
