# Jonathan Segovia's Portfolio

A personal portfolio site with an integrated AI "Ask Me Anything" page and a simple blog.

**Note:** This repository has been restructured as a monorepo. See [docs/monorepo.md](docs/monorepo.md) for the new structure.

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
- **AI**: Vercel AI SDK / OpenAI SDK with Vertex AI

### Backend
- **Framework**: FastAPI
- **MCP**: FastMCP for Model Context Protocol
- **AI**: Vertex AI RAG Engine with Vector Search

### Infrastructure
- **Deployment**: Google Cloud Run
- **Build System**: Turborepo
- **Package Manager**: pnpm workspaces

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
   
   **Frontend** (`frontend/.env.local`):
   ```
   VERTEX_AI_PROJECT_ID=your-gcp-project-id
   VERTEX_AI_LOCATION=us-central1
   VERTEX_AI_ENDPOINT_ID=your-endpoint-id
   LLM_MODEL_ID=qwen3-8b-vllm
   GOOGLE_APPLICATION_CREDENTIALS_JSON='{"type":"service_account",...}'
   ```
   
   **Backend** (`backend/.env`):
   ```
   PROJECT_ID=your-gcp-project-id
   LOCATION=us-central1
   RAG_CORPUS_NAME=projects/YOUR_PROJECT_ID/locations/us-central1/ragCorpora/YOUR_CORPUS_ID
   PORT=8080
   ```

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
├── docs/              # Documentation
└── packages/          # Shared packages (future)
```

See [docs/monorepo.md](docs/monorepo.md) for detailed information about the monorepo structure and workflows.

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

```bash
cd infra
./setup.sh
```

### Deploy Services

```bash
# Deploy backend
cd infra/backend
./deploy.sh

# Deploy frontend
cd infra/frontend
./deploy.sh
```

See [infra/README.md](infra/README.md) for detailed deployment instructions.

## Documentation

- [Monorepo Structure](docs/monorepo.md) - Detailed monorepo information
- [MCP GCP Implementation](docs/mcp_gcp.md) - Architecture and implementation guide
- [Infrastructure](infra/README.md) - Deployment and infrastructure setup
- [Backend README](backend/README.md) - Backend service documentation

## License

This project is licensed under the MIT License - see the LICENSE file for details.

