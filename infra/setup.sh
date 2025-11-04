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

