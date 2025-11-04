# Infrastructure Configuration

This directory contains deployment configurations for Cloud Run services.

## Structure

```
infra/
├── backend/
│   ├── Dockerfile          # Backend service Dockerfile
│   ├── cloudrun.yaml        # Cloud Run service template (declarative)
│   └── deploy.sh           # Backend deployment script
├── frontend/
│   ├── Dockerfile         # Frontend service Dockerfile
│   └── deploy.sh          # Frontend deployment script
├── setup.sh               # GCP infrastructure setup script
└── README.md             # This file
```

## Prerequisites

1. Google Cloud SDK (`gcloud`) installed and configured
2. Authenticated with `gcloud auth login`
3. Project ID set: `gcloud config set project YOUR_PROJECT_ID`

## Setup

Run the setup script to enable APIs and create necessary resources:

```bash
chmod +x setup.sh
./setup.sh
```

Or manually set environment variables:

```bash
export PROJECT_ID=your-project-id
export REGION=us-east1
export OPENAI_API_KEY=your-openai-key  # Optional: will prompt if not set
export RAG_CORPUS_NAME=projects/.../ragCorpora/...  # Optional: will prompt if not set
./setup.sh
```

This script will:
- Enable required GCP APIs (Vertex AI, Cloud Run, Storage, Pub/Sub, Eventarc, Artifact Registry)
- Create Artifact Registry repository for container images
- Create a service account for the MCP backend
- Grant necessary IAM roles
- Create/update secrets for RAG_CORPUS_NAME and OPENAI_API_KEY

## Deployment

### Backend Deployment

1. Ensure you have created a Vertex AI RAG corpus and have its resource name
2. Ensure secrets are created (via `setup.sh` or manually):
   - `RAG_CORPUS_NAME`: Full resource name of the RAG corpus
   - `OPENAI_API_KEY`: OpenAI API key for chat endpoints

3. Deploy the backend:

```bash
cd backend
chmod +x ../infra/backend/deploy.sh
../infra/backend/deploy.sh
```

Or with custom values:

```bash
PROJECT_ID=your-project-id REGION=us-east1 SERVICE_NAME=mcp-backend ../infra/backend/deploy.sh
```

The deployment script:
- Builds the container image using Cloud Build
- Pushes to Artifact Registry
- Renders the service YAML template with environment variables
- Deploys to Cloud Run using the declarative YAML (private by default)

### Frontend Deployment

```bash
cd frontend
chmod +x ../infra/frontend/deploy.sh
../infra/frontend/deploy.sh
```

## Environment Variables

### Backend

The backend requires these environment variables (set via Cloud Run secrets/env vars):

- `PROJECT_ID`: Your GCP project ID
- `LOCATION`: Vertex AI region (e.g., `us-east1`)
- `RAG_CORPUS_NAME`: Full resource name of the RAG corpus (stored as secret)
- `OPENAI_API_KEY`: OpenAI API key for chat endpoints (stored as secret)
- `CHAT_MODEL_ID`: Model ID override (default: `gpt-4o-mini`)
- `GCS_BUCKET_NAME`: GCS bucket name (default: `segov-dev-bucket`)
- `USE_MCP_IN_CHAT`: Enable MCP tools in chat (default: `true`)

### Frontend

The frontend uses environment variables from `.env.local` (configured via Cloud Run or build-time env vars).

## Service Account Permissions

The MCP backend service account requires:

- `roles/aiplatform.user`: Access Vertex AI APIs
- `roles/storage.objectViewer`: Read from GCS buckets
- `roles/run.invoker`: Invoke Cloud Run services (if needed)

## Access Control (IAM)

The backend service is deployed as **private** (IAM-only access). No public (`allUsers`) access is granted by default.

To grant access to specific principals (e.g., frontend service account or users):

```bash
gcloud run services add-iam-policy-binding mcp-backend \
  --region us-east1 \
  --member serviceAccount:frontend-sa@PROJECT_ID.iam.gserviceaccount.com \
  --role roles/run.invoker \
  --project PROJECT_ID
```

For user access:

```bash
gcloud run services add-iam-policy-binding mcp-backend \
  --region us-east1 \
  --member user:user@example.com \
  --role roles/run.invoker \
  --project PROJECT_ID
```

## GitHub Actions CI/CD

The repository includes GitHub Actions workflows for automated deployment:

- `.github/workflows/deploy.yml`: Workflow that triggers on pushes to `main` branch
- `.github/workflows/_cloudrun_deploy.yaml`: Reusable workflow that builds, pushes, and deploys

### Setup for GitHub Actions

1. **Set up Workload Identity Federation** (see [Google Cloud docs](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines))

2. **Configure GitHub Environment** (`prod`) with:
   - **Variables**:
     - `REGION=us-east1`
     - `GCP_PROJECT_ID=segov-dev-model`
     - `ARTIFACT_REPO=containers`
     - `SERVICE_NAME=mcp-backend`
     - `CHAT_MODEL_ID=gpt-5-nano-2025-08-07`
     - `GCS_BUCKET_NAME=segov-dev-bucket`
     - `SERVICE_ACCOUNT` (optional, defaults to `mcp-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com`)
   - **Secrets**:
     - `WIF_PROVIDER`: Workload Identity Federation provider
     - `WIF_SERVICE_ACCOUNT`: Service account for deployment

3. The service account used for GitHub Actions needs:
   - `roles/artifactregistry.writer`: Push images to Artifact Registry
   - `roles/run.admin`: Deploy to Cloud Run
   - `roles/iam.serviceAccountUser`: Impersonate the Cloud Run service account
   - `roles/iam.workloadIdentityUser`: Use Workload Identity Federation

## Optional: Pub/Sub Auto-Ingest Setup

To enable automatic ingestion on GCS object creation:

1. Create a Pub/Sub topic:

```bash
gcloud pubsub topics create gcs-upload-notifications --project ${PROJECT_ID}
```

2. Configure GCS bucket notifications:

```bash
gsutil notification create \
  -t gcs-upload-notifications \
  -f json \
  -e OBJECT_FINALIZE \
  gs://your-bucket-name
```

3. Create an Eventarc trigger to invoke the backend:

```bash
gcloud eventarc triggers create trigger-gcs-ingest \
  --location=${REGION} \
  --destination-run-service=mcp-backend \
  --destination-run-region=${REGION} \
  --event-filters="type=google.cloud.storage.object.v1.finalized" \
  --event-filters="bucket=your-bucket-name" \
  --service-account=${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com
```

## Troubleshooting

- **Build failures**: Ensure Cloud Build API is enabled
- **Permission errors**: Verify service account has correct IAM roles
- **Deployment timeouts**: Increase `--timeout` value or check resource limits
- **Secret not found**: Ensure `RAG_CORPUS_NAME` secret exists and is accessible

