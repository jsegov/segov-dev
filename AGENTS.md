# AGENTS.md

A guide for AI coding agents working on segov-dev.

## Project Overview

This is a monorepo containing:
- **Frontend**: Next.js 15 portfolio site with TypeScript strict mode, Tailwind CSS, file-based content management (JSON and Markdown). The site features a terminal-inspired design, blog functionality, and an "Ask Me Anything" chatbot page. The chatbot calls a FastAPI backend deployed on Cloud Run, which handles all LLM interactions with a self-hosted Qwen3-8B model on GCP vLLM.
- **Backend**: FastAPI-based MCP server for Vertex AI RAG Engine operations, deployed on Google Cloud Run. All LLM calls are made to the self-hosted vLLM instance.
- **Infrastructure**: Cloud Run deployment configurations and one-time bootstrap scripts for GCP infrastructure setup

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

## Infrastructure Setup

### One-Time GCP Infrastructure Bootstrap

Before deploying the backend, run the one-time infrastructure setup script:

```bash
cd infra && ./setup.sh
```

This script (idempotent, safe to rerun) sets up:
- Required GCP APIs
- Artifact Registry for container images
- Service account with minimal IAM roles
- Workload Identity Federation (WIF) for Vercel authentication
- GCS bucket for document ingestion
- Secret Manager secrets (`OPENAI_API_KEY`, `RAG_CORPUS_NAME`)

**Default values (can be overridden via environment variables):**
- `PROJECT_ID`: `segov-dev-model` (hardcoded)
- `REGION`: `us-east1`
- `SERVICE_ACCOUNT_NAME`: `mcp-sa`
- `GCS_BUCKET_NAME`: `segov-dev-bucket`
- `CHAT_MODEL_ID`: `gpt-5-nano-2025-08-07`

**Optional environment variables for setup:**
- `OPENAI_API_KEY` - If set, creates/updates the secret automatically
- `RAG_CORPUS_NAME` or `CORPUS_ID` - If set, creates/updates the secret automatically
- `VERCEL_TEAM_SLUG` - If using Vercel team accounts

### Backend Deployment

Deploy the backend to Cloud Run:

```bash
cd backend && ../infra/backend/deploy.sh
```

The deploy script uses the same defaults as the setup script. No environment variables required unless overriding defaults.

## Environment Variables

### Frontend (`frontend/.env.local` for local dev, Vercel Project Settings for production)

**Local Development:**
- `CHAT_BACKEND_URL` - (Optional) Backend URL for local development (defaults to `http://localhost:8080`)

**Production (Vercel Environment Variables):**
- `GCP_PROJECT_NUMBER` - GCP project number (from `gcloud projects describe PROJECT_ID --format='value(projectNumber)'`)
- `WIF_POOL_ID` - Workload Identity Pool ID (default: `vercel-pool`, set by `infra/setup.sh`)
- `WIF_PROVIDER_ID` - Workload Identity Provider ID (default: `vercel-oidc`, set by `infra/setup.sh`)
- `SERVICE_ACCOUNT_EMAIL` - Service account email that WIF impersonates (e.g., `mcp-sa@segov-dev-model.iam.gserviceaccount.com`)
- `CLOUD_RUN_URL` - Cloud Run service URL (ending in `.run.app`, used as ID token audience)

**Note:** The frontend uses Workload Identity Federation (WIF) to authenticate with Cloud Run. When `CLOUD_RUN_URL` is set, the BFF (`frontend/app/api/chatbot/route.ts`) exchanges Vercel OIDC tokens for Google ID tokens via WIF and calls the Cloud Run backend. If `CLOUD_RUN_URL` is not set, it falls back to calling the local backend without authentication.

**Architecture:** Frontend → Backend API route → Cloud Run backend → GCP vLLM (Qwen3-8B)

### Backend (`backend/.env`)

**Required:**
- `PROJECT_ID` - GCP project ID (default: `segov-dev-model` in deploy scripts)
- `LOCATION` - Vertex AI region (default: `us-east1`)
- `RAG_CORPUS_NAME` - Full resource name of the RAG corpus (stored in Secret Manager)
- `OPENAI_API_KEY` - OpenAI API key (use `EMPTY` for vLLM)
- `OPENAI_BASE_URL` - Base URL for vLLM (e.g., `http://YOUR_VLLM_IP:8000/v1`)
- `CHAT_MODEL_ID` - Model ID (default: `Qwen/Qwen3-8B`)
- `GCS_BUCKET_NAME` - GCS bucket for document ingestion (default: `segov-dev-bucket`)
- `USE_MCP_IN_CHAT` - Enable MCP tools in chat (default: `true`)
- `MCP_REQUIRE_AUTH` - Require MCP authentication (default: `false`)

**Note:** The backend makes calls to the self-hosted vLLM instance. All LLM interactions are handled server-side.

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

1. **Initial setup**: 
   - Run `pnpm install` to install dependencies
   - Set up GCP infrastructure: `cd infra && ./setup.sh`
   - Export environment variables from `backend/.env` if needed (see Environment Variables section)
2. **Start dev servers**: 
   - Run `pnpm dev` to start all development servers
   - Or run `pnpm --filter frontend dev` for frontend only (http://localhost:3000)
   - Or run `uvicorn app.main:app --reload` from `backend/` for backend only (http://localhost:8080)
3. **Make changes**: Edit files and let hot reload handle updates
4. **Test locally**: Use `pnpm test:watch` to keep tests running during development
5. **Deploy backend**: Run `cd backend && ../infra/backend/deploy.sh` (uses defaults from setup.sh)
6. **Before committing**: Always run `pnpm lint` and `pnpm test` to ensure code quality

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
