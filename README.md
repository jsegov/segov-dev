# Jonathan Segovia's Portfolio

A personal portfolio site with an integrated AI "Ask Me Anything" page and a simple blog.

**Note:** This repository has been restructured as a monorepo.

## Features

- **Terminal-inspired Design**: Dark theme with monospace font and terminal-like UI elements
- **Responsive Layout**: Works on all device sizes
- **Content Management**: File-based content using JSON and Markdown
- **Static Site Generation**: Fast loading with Next.js SSG and ISR fallback
- **AI Chatbot**: "Ask Me Anything" page with streaming responses
- **Blog**: Content-rich blog with reading time estimates
- **Projects Showcase**: Display portfolio projects in a responsive grid
- **Career Timeline**: Visual representation of professional experience
- **MCP Backend**: Vertex AI RAG-powered MCP server for document search and ingestion

## Tech Stack

### Frontend
- **Framework**: Next.js 15+ (App Router) with TypeScript
- **Styling**: Tailwind CSS
- **Content**: JSON files and Markdown blog posts with SSG and ISR (24h revalidation)
- **Deployment**: Vercel (with Workload Identity Federation for Cloud Run backend authentication)
- **Architecture**: Frontend → Backend API route → Cloud Run backend → OpenAI API (direct)

### Backend
- **Framework**: FastAPI
- **MCP**: FastMCP for Model Context Protocol
- **AI**: Self-hosted Qwen3-8B on GCP vLLM (OpenAI-compatible API)
- **RAG**: Vertex AI RAG Engine with Vector Search
- **Deployment**: Google Cloud Run (us-east1)

### Infrastructure
- **Deployment**: Google Cloud Run (backend), Vercel (frontend)
- **Build System**: Turborepo
- **Package Manager**: pnpm workspaces
- **Authentication**: Workload Identity Federation (WIF) for Vercel → Cloud Run

## Getting Started

### Prerequisites

- Node.js 18+ and pnpm 9+
- Python 3.11+ (for backend)
- Google Cloud Project with Vertex AI enabled
- `gcloud` CLI configured

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/segovia-dev/segov-dev.git
   cd segov-dev
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

3. Set up environment variables:
   
   **Frontend** (`frontend/.env.local` for local development):
   ```
   CHAT_BACKEND_URL=http://localhost:8080  # Optional, defaults to http://localhost:8080
   ```
   
   **Backend** (`backend/.env`):
   ```
   PROJECT_ID=segov-dev-model  # Default, can be overridden
   LOCATION=us-east1  # Default, can be overridden
   RAG_CORPUS_NAME=projects/segov-dev-model/locations/us-east1/ragCorpora/YOUR_CORPUS_ID
   OPENAI_API_KEY=EMPTY  # Use 'EMPTY' for vLLM if no auth
   OPENAI_BASE_URL=http://YOUR_VLLM_IP:8000/v1
   CHAT_MODEL_ID=Qwen/Qwen3-8B  # Optional, defaults to Qwen/Qwen3-8B
   GCS_BUCKET_NAME=segov-dev-bucket  # Optional, defaults to segov-dev-bucket
   ```
   
   **Note**: For production, secrets (`OPENAI_API_KEY`, `RAG_CORPUS_NAME`) are managed via Google Secret Manager. The frontend uses Workload Identity Federation (WIF) to authenticate with the Cloud Run backend. See [AGENTS.md](AGENTS.md) for production environment variable setup.

4. Run development servers:
   ```bash
   # Run all apps
   pnpm dev
   
   # Or run individually
   pnpm --filter frontend dev
   pnpm --filter backend dev
   ```

5. Open [http://localhost:3000](http://localhost:3000) for the frontend and [http://localhost:8080](http://localhost:8080) for the backend API.

## Monorepo Structure

```
segov-dev/
├── frontend/          # Next.js portfolio application
├── backend/           # FastAPI MCP server
├── infra/             # Cloud Run deployment configs
└── packages/          # Shared packages (future)
```

## Development

### Running Tasks

Use Turborepo to run tasks across workspaces:

```bash
pnpm dev       # Start all dev servers
pnpm build     # Build all apps
pnpm lint      # Lint all workspaces
pnpm test      # Test all workspaces
pnpm format    # Format code
```

### Frontend Development

```bash
cd frontend
pnpm dev      # Start Next.js dev server
pnpm build    # Build for production
pnpm test     # Run tests
```

### Backend Development

```bash
cd backend
pip install -r requirements.txt  # Or: poetry install
uvicorn app.main:app --reload
```

## Deployment

### Setup GCP Infrastructure

First, run the one-time infrastructure bootstrap script (idempotent, safe to rerun):

```bash
cd infra && ./setup.sh
```

This sets up:
- Required GCP APIs
- Artifact Registry for container images
- Service account with minimal IAM roles
- Workload Identity Federation (WIF) for Vercel authentication
- GCS bucket for document ingestion
- Secret Manager secrets (`OPENAI_API_KEY`, `RAG_CORPUS_NAME`)

**Default values** (can be overridden via environment variables):
- `PROJECT_ID`: `segov-dev-model` (hardcoded)
- `REGION`: `us-east1`
- `SERVICE_ACCOUNT_NAME`: `mcp-sa`
- `GCS_BUCKET_NAME`: `segov-dev-bucket`
- `CHAT_MODEL_ID`: `Qwen/Qwen3-8B`

### Deploy Services

**Backend (Cloud Run):**
```bash
cd backend && ../infra/backend/deploy.sh
```

The deploy script uses the same defaults as the setup script. No environment variables required unless overriding defaults.

**Frontend (Vercel):**
The frontend is deployed separately on Vercel. After deploying the backend, add these environment variables to your Vercel project:
- `GCP_PROJECT_NUMBER` - GCP project number
- `WIF_POOL_ID` - Workload Identity Pool ID (default: `vercel-pool`)
- `WIF_PROVIDER_ID` - Workload Identity Provider ID (default: `vercel-oidc`)
- `SERVICE_ACCOUNT_EMAIL` - Service account email (e.g., `mcp-sa@segov-dev-model.iam.gserviceaccount.com`)
- `CLOUD_RUN_URL` - Cloud Run service URL (from backend deployment output)

**Alternative: Frontend on Cloud Run**
If you want to deploy the frontend to Cloud Run instead of Vercel:
```bash
cd infra/frontend && ./deploy.sh
```

See [AGENTS.md](AGENTS.md) and [infra/README.md](infra/README.md) for detailed deployment instructions.

## Documentation

- [AGENTS.md](AGENTS.md) - Guide for AI coding agents (includes setup, deployment, and environment variables)
- [Infrastructure](infra/README.md) - Deployment and infrastructure setup
- [Backend README](backend/README.md) - Backend service documentation

## License

This project is licensed under the MIT License - see the LICENSE file for details.

