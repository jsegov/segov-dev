#!/bin/bash
# Setup script for GCP infrastructure

set -e

PROJECT_ID=${PROJECT_ID:-"your-project-id"}
REGION=${REGION:-"us-central1"}
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

# Create secret for RAG corpus name (placeholder - replace with actual corpus name)
echo "Creating secret for RAG corpus name..."
echo "projects/${PROJECT_ID}/locations/${REGION}/ragCorpora/YOUR_CORPUS_ID" | \
  gcloud secrets create RAG_CORPUS_NAME \
  --data-file=- \
  --project ${PROJECT_ID} || \
  echo "Secret may already exist. Update it manually with: gcloud secrets versions add RAG_CORPUS_NAME --data-file=-"

echo "Infrastructure setup complete!"
echo ""
echo "Next steps:"
echo "1. Create a Vertex AI RAG corpus and update the RAG_CORPUS_NAME secret"
echo "2. Deploy the backend: cd backend && ../infra/backend/deploy.sh"
echo "3. Deploy the frontend: cd frontend && ../infra/frontend/deploy.sh"

