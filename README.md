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
   OPENAI_API_KEY=your_openai_api_key
   
   # Optional: Use self-hosted GKE vLLM endpoint
   # Note: Do NOT include /v1 in OPENAI_BASE_URL - the OpenAI SDK appends it automatically
   OPENAI_BASE_URL=https://llm.your-domain.com
   LLM_MODEL_ID=Qwen/Qwen3-8B-FP8
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
├── infra/                  # Infrastructure as code
│   ├── gke/                # GKE-specific manifests and scripts
│   │   ├── manifests/      # Kubernetes manifests (namespace, deployment, ingress)
│   │   ├── scripts/        # Deployment helper scripts
│   │   └── env.example     # Infrastructure environment variables template
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

## Infrastructure Deployment

This project includes Infrastructure as Code (IaC) for deploying a self-hosted LLM (Qwen3-8B-FP8) on Google Kubernetes Engine (GKE) Autopilot. The infrastructure is automatically deployed via GitHub Actions when changes are pushed to the `infra/gke/` directory.

### GitHub Actions Workflow

The `.github/workflows/deploy-gke-infra.yml` workflow automatically deploys infrastructure when:
- Changes are pushed to `infra/**` on the `main` branch
- The workflow is manually triggered via `workflow_dispatch`

### Required GitHub Secrets

Before deploying, configure the following repository secrets in GitHub (Settings → Secrets and variables → Actions):

**Required:**
- `GCP_PROJECT` - GCP project ID hosting the GKE cluster
- `GKE_CLUSTER_NAME` - Autopilot cluster name
- `GKE_CLUSTER_LOCATION` - Region of the cluster (e.g., us-central1)

**Optional:**
- `HF_AUTH_TOKEN` - Hugging Face authentication token (only needed for gated models)

### Setting Up Secrets

1. **Prepare GKE access:**
   - Ensure the target project has a GKE Autopilot cluster with GPU quota (e.g., L4).
   - Enable Workload Identity and create a GCP service account mapped to the Kubernetes service account (`vllm-sa`).
   - Reserve a global static IP and configure DNS for your domain if exposing via HTTPS.

2. **Add secrets & variables to GitHub:**
   - Secrets: `GCP_PROJECT`, `GCP_WORKLOAD_ID_PROVIDER`, `GCP_DEPLOYER_SA_EMAIL`, `GKE_CLUSTER_NAME`, `GKE_CLUSTER_LOCATION`, `GKE_STATIC_IP_NAME`, `GKE_DOMAIN`, `VLLM_GCP_SERVICE_ACCOUNT`, `GKE_ARMOR_POLICY` (optional).
   - Variables (override defaults as needed): `GKE_STORAGE_CLASS`, `GKE_MODEL_CACHE_STORAGE`, `GKE_VLLM_IMAGE`, `GKE_VLLM_GPU_LIMIT`, `GKE_VLLM_GPU_REQUEST`, `GKE_VLLM_CPU_LIMIT`, `GKE_VLLM_CPU_REQUEST`, `GKE_VLLM_MEMORY_LIMIT`, `GKE_VLLM_MEMORY_REQUEST`, `GKE_VLLM_EPHEMERAL_REQUEST`, `GKE_VLLM_MODEL_ID`, `GKE_GPU_TYPE`, `GKE_VLLM_REPLICAS`.

### Manual Deployment

To manually trigger the deployment workflow:

1. Go to the "Actions" tab in your GitHub repository
2. Select "Deploy GKE Infra" from the workflow list
3. Click "Run workflow" and select the branch
4. Click the green "Run workflow" button

### Deployment Process

The workflow performs the following steps:

1. **Setup**: Authenticates to GCP with OIDC, installs gcloud (with the GKE auth plugin), kubectl, and envsubst.
2. **Cluster Credentials**: Retrieves cluster credentials via `google-github-actions/get-gke-credentials`.
3. **Deployment**: Runs `infra/gke/scripts/deploy_gke.sh`, templating manifests and applying them in order.
4. **Verification**: Lists pods/ingress and prints the ingress endpoint; you can add health checks as needed.

### Post-Deployment

After successful deployment:

1. The workflow logs the HTTPS endpoint (IP or hostname). Once DNS and the managed certificate become active, the endpoint serves `/health` and `/v1`.
2. Update application environments with `OPENAI_BASE_URL=https://<your-domain>` (do NOT include `/v1` - the OpenAI SDK appends it automatically).
3. (Optional) Configure Cloud Armor policies and verify access from allowed IPs.

### Infrastructure Configuration

Infrastructure configuration files are located in the `infra/` directory:

- `infra/gke/manifests/` - Kubernetes manifests (namespace, service account, deployment, ingress)
- `infra/gke/scripts/` - Deployment helper scripts (e.g., `deploy_gke.sh`)
- `infra/gke/env.example` - Environment variables template for GKE deployments

See `docs/gke_openai_migration.md` for detailed infrastructure documentation.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
