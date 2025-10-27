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

## Tech Stack

- **Framework**: Next.js 15+ (App Router) with TypeScript
- **Styling**: Tailwind CSS
- **Content**: Contentful CMS with SSG and ISR (24h revalidation)
- **Deployment**: Vercel with GitHub Actions CI/CD
- **AI**: Vercel AI SDK

## Getting Started

### Prerequisites

- Node.js 15+ and npm/yarn
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
   
   # Optional: Use self-hosted CoreWeave vLLM endpoint
   OPENAI_BASE_URL=https://basic-inference.<orgid>-<cluster>.coreweave.app/v1
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
│   ├── manifests/          # Kubernetes manifests (PVCs, secrets)
│   ├── helm-values/        # Helm chart values for deployments
│   ├── scripts/            # Deployment helper scripts
│   └── env.example         # Infrastructure environment variables template
├── lib/                    # Utility functions and API clients
│   ├── contentful/         # Contentful API integration
│   └── openai/             # OpenAI API integration
├── public/                 # Static assets
├── styles/                 # Global CSS and Tailwind configuration
└── types/                  # TypeScript type definitions
```

## Local Development Guide

### Environment Variables Setup

For local development, ensure your `.env.local` file has the correct Contentful credentials:

```
CONTENTFUL_SPACE_ID=your_space_id
CONTENTFUL_ACCESS_TOKEN=your_access_token
CONTENTFUL_ENVIRONMENT=master
```

## Infrastructure Deployment

This project includes Infrastructure as Code (IaC) for deploying a self-hosted LLM (Qwen3-8B-FP8) on CoreWeave Kubernetes. The infrastructure is automatically deployed via GitHub Actions when changes are pushed to the `infra/` directory.

### GitHub Actions Workflow

The `.github/workflows/deploy-infra.yml` workflow automatically deploys infrastructure when:
- Changes are pushed to `infra/**` on the `main` branch
- The workflow is manually triggered via `workflow_dispatch`

### Required GitHub Secrets

Before deploying, configure the following repository secrets in GitHub (Settings → Secrets and variables → Actions):

**Required:**
- `COREWEAVE_KUBECONFIG_B64` - Base64-encoded kubeconfig file for your CoreWeave cluster
- `COREWEAVE_ORG_ID` - Your CoreWeave organization ID
- `COREWEAVE_CLUSTER_NAME` - Your CoreWeave cluster name

**Optional:**
- `HF_AUTH_TOKEN` - Hugging Face authentication token (only needed for gated models)

### Setting Up Secrets

1. **Obtain CoreWeave credentials:**
   - Log into CoreWeave Cloud Console
   - Navigate to API Access → create a token → download kubeconfig
   - Get your organization ID and cluster name from the console

2. **Base64 encode kubeconfig:**
   ```bash
   cat your-kubeconfig.yaml | base64 | pbcopy  # macOS
   cat your-kubeconfig.yaml | base64 | xclip   # Linux
   ```

3. **Add secrets to GitHub:**
   - Go to your repository → Settings → Secrets and variables → Actions
   - Click "New repository secret" for each required secret
   - Paste the values and save

### Manual Deployment

To manually trigger the deployment workflow:

1. Go to the "Actions" tab in your GitHub repository
2. Select "Deploy CoreWeave Infra" from the workflow list
3. Click "Run workflow" and select the branch
4. Click the green "Run workflow" button

### Deployment Process

The workflow performs the following steps:

1. **Setup**: Installs kubectl, Helm, and required dependencies
2. **Authentication**: Configures kubeconfig from secrets
3. **Verification**: Validates cluster access
4. **Deployment**: Runs `infra/scripts/deploy_infra.sh` which deploys:
   - Traefik Ingress Controller
   - cert-manager for TLS certificates
   - PersistentVolumeClaim for model caching
   - vLLM inference service with Qwen3-8B-FP8 model
5. **Verification**: Checks deployment readiness and performs health check
6. **Output**: Displays the vLLM endpoint URL

### Post-Deployment

After successful deployment:

1. The workflow outputs the vLLM endpoint URL (e.g., `https://basic-inference.<orgid>-<cluster>.coreweave.app`)
2. Update your frontend environment variable `OPENAI_BASE_URL` with this endpoint
3. The LLM service will be available at `/v1` path for OpenAI-compatible API calls

### Infrastructure Configuration

Infrastructure configuration files are located in the `infra/` directory:

- `infra/manifests/` - Kubernetes manifests (PVCs, secrets)
- `infra/helm-values/` - Helm chart values for deployments
- `infra/scripts/` - Deployment helper scripts
- `infra/env.example` - Environment variables template

See `docs/coreweave_llm_deployment.md` for detailed infrastructure documentation.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
