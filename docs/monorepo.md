# Monorepo Structure

This repository is organized as a monorepo using Turborepo and pnpm workspaces.

## Structure

```
segov-dev/
├── frontend/          # Next.js portfolio application
├── backend/           # FastAPI MCP server for Vertex AI RAG
├── infra/             # Cloud Run deployment configurations
├── packages/          # Shared packages (future use)
├── docs/              # Documentation
├── pnpm-workspace.yaml # pnpm workspace configuration
├── turbo.json         # Turborepo configuration
└── package.json       # Root package.json
```

## Workspace Management

### Package Manager

This monorepo uses **pnpm** with workspaces. The root `pnpm-workspace.yaml` defines which directories are part of the workspace.

### Build System

**Turborepo** is used for task orchestration and caching. It provides:

- Incremental builds (only rebuild what changed)
- Local and remote caching
- Parallel task execution
- Dependency-aware task ordering

## Development

### Installation

Install dependencies for all workspaces:

```bash
pnpm install
```

### Running Tasks

Use Turborepo to run tasks across all workspaces:

```bash
# Run dev servers for all apps
pnpm dev

# Build all apps
pnpm build

# Lint all workspaces
pnpm lint

# Test all workspaces
pnpm test

# Format code
pnpm format
```

### Workspace-Specific Tasks

You can also run tasks for specific workspaces:

```bash
# Run frontend dev server
pnpm --filter frontend dev

# Run backend tests
pnpm --filter backend test

# Build only frontend
pnpm --filter frontend build
```

## Applications

### Frontend (`frontend/`)

Next.js 15 portfolio application with:
- Terminal-inspired design
- Blog functionality
- AI chatbot integration
- File-based content management

**Tech Stack:**
- Next.js 15+ (App Router)
- TypeScript
- Tailwind CSS
- Vitest for testing

**Commands:**
- `pnpm dev` - Start development server
- `pnpm build` - Build for production
- `pnpm lint` - Run ESLint
- `pnpm test` - Run tests

### Backend (`backend/`)

FastAPI-based MCP server for Vertex AI RAG operations.

**Tech Stack:**
- FastAPI
- FastMCP (Model Context Protocol)
- Vertex AI Python SDK
- Google Cloud Storage

**Commands:**
- `uvicorn app.main:app --reload` - Start development server
- See `backend/README.md` for more details

**MCP Tools:**
- `vector_search` - Search documents using vector similarity
- `ingest_from_gcs` - Ingest documents from GCS into RAG corpus
- `doc_get` - Retrieve document content by ID or URI

### Infrastructure (`infra/`)

Deployment configurations for Google Cloud Run:
- Dockerfiles for frontend and backend
- Deployment scripts
- GCP setup scripts
- IAM and service account configurations

See `infra/README.md` for deployment instructions.

## Environment Variables

### Frontend

Create `frontend/.env.local`:

```env
VERTEX_AI_PROJECT_ID=your-gcp-project-id
VERTEX_AI_LOCATION=us-central1
VERTEX_AI_ENDPOINT_ID=your-endpoint-id
LLM_MODEL_ID=qwen3-8b-vllm
GOOGLE_APPLICATION_CREDENTIALS_JSON='{"type":"service_account",...}'
```

### Backend

Create `backend/.env`:

```env
PROJECT_ID=your-gcp-project-id
LOCATION=us-central1
RAG_CORPUS_NAME=projects/YOUR_PROJECT_ID/locations/us-central1/ragCorpora/YOUR_CORPUS_ID
PORT=8080
```

## Deployment

### Setup GCP Infrastructure

```bash
cd infra
chmod +x setup.sh
./setup.sh
```

### Deploy Backend

```bash
cd infra/backend
./deploy.sh
```

### Deploy Frontend

```bash
cd infra/frontend
./deploy.sh
```

See `infra/README.md` for detailed deployment instructions.

## CI/CD

Turborepo is designed to work seamlessly with CI/CD pipelines. The remote caching feature allows sharing build artifacts across CI runs, significantly speeding up builds.

Example GitHub Actions workflow:

```yaml
name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install
      - run: pnpm build
      - run: pnpm lint
      - run: pnpm test
```

## Caching

Turborepo caches:
- Build outputs
- Test results
- Lint results

Cache keys are based on:
- Source code file hashes
- Dependency versions
- Task configurations

To clear cache:

```bash
pnpm turbo clean
```

## Future Improvements

- Add shared TypeScript configs in `packages/`
- Add shared UI components library
- Implement shared utilities package
- Add end-to-end testing setup

