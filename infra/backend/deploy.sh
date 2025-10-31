#!/bin/bash
# Deploy backend MCP server to Cloud Run

set -e

# Configuration
PROJECT_ID=${PROJECT_ID:-"your-project-id"}
REGION=${REGION:-"us-central1"}
SERVICE_NAME=${SERVICE_NAME:-"mcp-backend"}
SERVICE_ACCOUNT=${SERVICE_ACCOUNT:-"mcp-sa@${PROJECT_ID}.iam.gserviceaccount.com"}

# Build and deploy
echo "Building and deploying ${SERVICE_NAME} to Cloud Run..."

gcloud run deploy ${SERVICE_NAME} \
  --source ../backend \
  --platform managed \
  --region ${REGION} \
  --project ${PROJECT_ID} \
  --service-account ${SERVICE_ACCOUNT} \
  --allow-unauthenticated=false \
  --memory 512Mi \
  --cpu 1 \
  --timeout 300 \
  --min-instances 0 \
  --max-instances 10 \
  --set-env-vars PROJECT_ID=${PROJECT_ID},LOCATION=${REGION} \
  --set-secrets RAG_CORPUS_NAME=RAG_CORPUS_NAME:latest

echo "Deployment complete!"
echo "Service URL: $(gcloud run services describe ${SERVICE_NAME} --region ${REGION} --project ${PROJECT_ID} --format 'value(status.url)')"

