#!/bin/bash
# Setup script for GCP infrastructure

set -e

PROJECT_ID=${PROJECT_ID:-"your-project-id"}
REGION=${REGION:-"us-east1"}
SERVICE_ACCOUNT_NAME="mcp-sa"

echo "Setting up GCP infrastructure for MCP backend..."

# Enable required APIs
echo "Enabling required APIs..."
gcloud services enable \
  aiplatform.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  storage.googleapis.com \
  pubsub.googleapis.com \
  eventarc.googleapis.com \
  artifactregistry.googleapis.com \
  iam.googleapis.com \
  sts.googleapis.com \
  vpcaccess.googleapis.com \
  --project ${PROJECT_ID}

# Create service account for MCP backend
echo "Creating service account..."
gcloud iam service-accounts create ${SERVICE_ACCOUNT_NAME} \
  --display-name="MCP Backend Service Account" \
  --project ${PROJECT_ID} || echo "Service account may already exist"

# Grant necessary roles
echo "Granting IAM roles..."
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"

gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer"

gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

# Set up Workload Identity Federation for Vercel OIDC
echo "Setting up Workload Identity Federation for Vercel..."
PROJECT_NUMBER=$(gcloud projects describe ${PROJECT_ID} --format='value(projectNumber)')
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
POOL_ID="vercel-pool"
PROVIDER_ID="vercel-oidc"

# Get Vercel team slug (optional, can be set via env)
VERCEL_TEAM_SLUG=${VERCEL_TEAM_SLUG:-""}
if [ -z "${VERCEL_TEAM_SLUG}" ]; then
  echo "Warning: VERCEL_TEAM_SLUG not set. Using default issuer."
  VERCEL_ISSUER="https://oidc.vercel.com"
else
  VERCEL_ISSUER="https://oidc.vercel.com/${VERCEL_TEAM_SLUG}"
fi

# Create workload identity pool (idempotent)
echo "Creating workload identity pool..."
gcloud iam workload-identity-pools create ${POOL_ID} \
  --project=${PROJECT_ID} \
  --location="global" \
  --display-name="Vercel OIDC Pool" \
  --description="Workload Identity Pool for Vercel OIDC federation" || \
  echo "Workload identity pool may already exist"

# Create OIDC provider in the pool (idempotent)
echo "Creating OIDC provider..."
gcloud iam workload-identity-pools providers create-oidc ${PROVIDER_ID} \
  --project=${PROJECT_ID} \
  --location="global" \
  --workload-identity-pool=${POOL_ID} \
  --display-name="Vercel OIDC Provider" \
  --issuer-uri=${VERCEL_ISSUER} \
  --allowed-audiences="https://vercel.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.project_id=assertion.project_id,attribute.branch=assertion.branch" || \
  echo "OIDC provider may already exist"

# Grant the pool permission to impersonate the service account
echo "Granting token creator role to WIF pool..."
POOL_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}"
gcloud iam service-accounts add-iam-policy-binding ${SERVICE_ACCOUNT_EMAIL} \
  --project=${PROJECT_ID} \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/${POOL_RESOURCE}/*" || \
  echo "IAM binding may already exist"

echo ""
echo "WIF Configuration Summary:"
echo "  PROJECT_NUMBER: ${PROJECT_NUMBER}"
echo "  POOL_ID: ${POOL_ID}"
echo "  PROVIDER_ID: ${PROVIDER_ID}"
echo "  SERVICE_ACCOUNT_EMAIL: ${SERVICE_ACCOUNT_EMAIL}"
echo "  VERCEL_ISSUER: ${VERCEL_ISSUER}"
echo ""
echo "Add these to your Vercel environment variables:"
echo "  GCP_PROJECT_NUMBER=${PROJECT_NUMBER}"
echo "  WIF_POOL_ID=${POOL_ID}"
echo "  WIF_PROVIDER_ID=${PROVIDER_ID}"
echo "  SERVICE_ACCOUNT_EMAIL=${SERVICE_ACCOUNT_EMAIL}"

# Create Artifact Registry repository (Docker) in us-east1 if not present
echo "Creating Artifact Registry repository..."
gcloud artifacts repositories create containers \
  --repository-format=docker \
  --location=${REGION} \
  --description="Container images" \
  --project ${PROJECT_ID} || echo "Repository may already exist"

# Create/update secrets
echo "Creating secrets..."

# OPENAI_API_KEY (requires value from environment)
if [ -n "${OPENAI_API_KEY:-}" ]; then
    echo -n "${OPENAI_API_KEY}" | gcloud secrets create OPENAI_API_KEY \
      --data-file=- --project ${PROJECT_ID} || \
      echo -n "${OPENAI_API_KEY}" | gcloud secrets versions add OPENAI_API_KEY --data-file=- --project ${PROJECT_ID}
    echo "OPENAI_API_KEY secret created/updated"
else
    echo "Warning: OPENAI_API_KEY not set. Create it manually with:"
    echo "  echo -n 'your-key' | gcloud secrets create OPENAI_API_KEY --data-file=- --project ${PROJECT_ID}"
fi

# RAG_CORPUS_NAME (requires value from environment or corpus ID)
if [ -n "${RAG_CORPUS_NAME:-}" ]; then
    echo -n "${RAG_CORPUS_NAME}" | gcloud secrets create RAG_CORPUS_NAME \
      --data-file=- --project ${PROJECT_ID} || \
      echo -n "${RAG_CORPUS_NAME}" | gcloud secrets versions add RAG_CORPUS_NAME --data-file=- --project ${PROJECT_ID}
    echo "RAG_CORPUS_NAME secret created/updated"
elif [ -n "${CORPUS_ID:-}" ]; then
    CORPUS_NAME="projects/${PROJECT_ID}/locations/${REGION}/ragCorpora/${CORPUS_ID}"
    echo -n "${CORPUS_NAME}" | gcloud secrets create RAG_CORPUS_NAME \
      --data-file=- --project ${PROJECT_ID} || \
      echo -n "${CORPUS_NAME}" | gcloud secrets versions add RAG_CORPUS_NAME --data-file=- --project ${PROJECT_ID}
    echo "RAG_CORPUS_NAME secret created/updated using CORPUS_ID"
else
    echo "Warning: RAG_CORPUS_NAME or CORPUS_ID not set. Create it manually with:"
    echo "  echo -n 'projects/${PROJECT_ID}/locations/${REGION}/ragCorpora/YOUR_CORPUS_ID' | gcloud secrets create RAG_CORPUS_NAME --data-file=- --project ${PROJECT_ID}"
fi

echo "Infrastructure setup complete!"
echo ""
echo "Next steps:"
echo "1. Create a Vertex AI RAG corpus and update the RAG_CORPUS_NAME secret"
echo "2. Deploy the backend: cd backend && ../infra/backend/deploy.sh"
echo "3. Deploy the frontend: cd frontend && ../infra/frontend/deploy.sh"

