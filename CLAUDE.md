# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a monorepo containing a personal portfolio site with an integrated AI chatbot. The frontend is a Next.js 15 application deployed to Vercel, and the backend is a FastAPI MCP server deployed to Google Cloud Run. The chatbot uses a self-hosted Qwen3-8B model running on Cloud Run with GPU.

## Commands

### Monorepo (Root)
```bash
pnpm install          # Install all dependencies
pnpm dev              # Start all dev servers (frontend:3000, backend:8080)
pnpm build            # Build all apps
pnpm lint             # Lint all workspaces
pnpm test             # Run all tests
pnpm test:watch       # Watch mode tests
pnpm coverage         # Test with coverage reports
pnpm format           # Format all code with Prettier
```

### Frontend Only
```bash
cd frontend
pnpm dev              # Next.js dev server on port 3000
pnpm test             # Run Vitest tests
pnpm vitest run tests/components/button.test.tsx  # Single test file
pnpm test:e2e         # Playwright e2e tests
pnpm test:e2e:ui      # Playwright UI mode
```

### Backend Only
```bash
cd backend
pip install -r requirements.txt  # Or: poetry install, uv pip install
uvicorn app.main:app --reload --host 0.0.0.0 --port 8080
pytest                           # Run all backend tests
pytest tests/test_routes.py      # Single test file
pytest -k "test_chat"            # Run tests matching pattern
```

### Infrastructure
```bash
cd infra && ./setup.sh                    # One-time GCP infrastructure bootstrap
cd backend && ../infra/backend/deploy.sh  # Deploy backend to Cloud Run
cd infra/gcp-vllm && ./deploy-cloudrun.sh # Deploy vLLM with GPU to Cloud Run
```

### CI/CD
- Push to `main` triggers GitHub Actions deployment to Cloud Run
- Workflows: `.github/workflows/deploy.yml` (backend), `vllm-deploy.yml` (GPU inference)

## Architecture

### Data Flow
```
Frontend (Vercel) → BFF API Route → Cloud Run Backend → Cloud Run vLLM GPU (Qwen3-8B)
                                  ↓
                          Vertex AI RAG Engine
```

### Key Patterns

**Backend-For-Frontend (BFF)**: The Next.js API route (`frontend/app/api/chatbot/route.ts`) handles Workload Identity Federation token exchange. It converts Vercel OIDC tokens to Google ID tokens to authenticate with Cloud Run.

**Model Context Protocol (MCP)**: The backend exposes MCP tools via FastMCP HTTP/SSE:
- `vector_search` - Search Vertex AI RAG corpus
- `doc_get` - Retrieve documents from GCS (whitelisted paths only)
- `ingest_from_gcs` - Ingest documents into RAG corpus

**LangChain Agent**: The backend uses LangChain for orchestration (`backend/app/agent.py`). The agent is built with `create_react_agent` and supports MCP tool calling. Chat history is managed via `RunnableWithMessageHistory`.

**Qwen3 Reasoning**: The model outputs `<think>...</think>` blocks for chain-of-thought reasoning. These are stripped in `routes_chat.py:strip_thinking_tags()` before returning to users.

### Directory Structure
```
frontend/           # Next.js 15 app (TypeScript, Tailwind, shadcn/ui)
├── app/            # App Router pages and API routes
├── components/     # React components
├── data/           # Static JSON content (projects, career)
└── tests/          # Vitest tests (mirrors components/)

backend/            # FastAPI MCP server (Python 3.11+)
├── app/
│   ├── main.py         # FastAPI + MCP server setup
│   ├── routes_chat.py  # Chat endpoints
│   ├── mcp_tools.py    # MCP tool implementations
│   ├── agent.py        # LangChain agent orchestration
│   └── prompts/        # System prompts (markdown)
└── tests/

infra/              # Cloud Run deployment configs
├── setup.sh        # One-time GCP bootstrap (idempotent)
├── backend/        # Backend Dockerfile + deploy script
├── frontend/       # Frontend Dockerfile + deploy script
└── gcp-vllm/       # vLLM GPU deployment (us-east4)
```

## Code Style

- **TypeScript**: Strict mode enabled
- **Quotes**: Single quotes only
- **Semicolons**: Never
- **Prettier**: Print width 100, trailing commas on all
- **ESLint**: Next.js core web vitals preset

Always run `pnpm lint` before committing.

## Testing

- **Frontend**: Vitest with happy-dom, React Testing Library
- **Backend**: pytest with pytest-asyncio
- **E2E**: Playwright

Write frontend tests in `frontend/tests/` mirroring the `components/` structure.

## Environment Variables

### Frontend Production (Vercel)
- `GCP_PROJECT_NUMBER`, `WIF_POOL_ID`, `WIF_PROVIDER_ID` - Workload Identity Federation
- `SERVICE_ACCOUNT_EMAIL` - Service account for WIF
- `CLOUD_RUN_URL` - Backend URL (ID token audience)

### Backend (`backend/.env`)
- `PROJECT_ID` - GCP project (default: segov-dev-model)
- `RAG_CORPUS_NAME` - Vertex AI RAG corpus resource name (Secret Manager)
- `OPENAI_BASE_URL` - vLLM Cloud Run URL
- `CHAT_MODEL_ID` - Model ID (default: Qwen/Qwen3-8B)

## Deployment Notes

- Backend deploys to Cloud Run in us-east1
- vLLM GPU deploys to us-east4 (GPU availability)
- vLLM uses scale-to-zero (~$0.67/hour active, $0 idle)
- Cold start for vLLM: 30-60 seconds for model loading
- All services are private (IAM-only access)
