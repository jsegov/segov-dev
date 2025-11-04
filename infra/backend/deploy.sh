#!/bin/bash
# Deploy backend MCP server to Cloud Run

set -e

# Configuration
PROJECT_ID=${PROJECT_ID:-"your-project-id"}
REGION=${REGION:-"us-east1"}
SERVICE_NAME=${SERVICE_NAME:-"mcp-backend"}
SERVICE_ACCOUNT=${SERVICE_ACCOUNT:-"mcp-sa@${PROJECT_ID}.iam.gserviceaccount.com"}

# Optional envs passed through
CHAT_MODEL_ID=${CHAT_MODEL_ID:-"gpt-4o-mini"}
GCS_BUCKET_NAME=${GCS_BUCKET_NAME:-"segov-dev-bucket"}

# Build and deploy
echo "Building and deploying ${SERVICE_NAME} to Cloud Run..."

# Check if envsubst is available
if ! command -v envsubst &> /dev/null; then
    echo "Error: envsubst is required but not found. Install gettext package."
    exit 1
fi

# Render service YAML
echo "Rendering service YAML..."
export CONTAINER_IMAGE=""
export PROJECT_ID
export REGION
export SERVICE_NAME
export CHAT_MODEL_ID
export GCS_BUCKET_NAME

# First, build and push the image if not already built
if [ -z "${SKIP_BUILD:-}" ]; then
    echo "Building container image..."
    IMAGE_TAG="${REGION}-docker.pkg.dev/${PROJECT_ID}/containers/${SERVICE_NAME}:$(date +%s)"
    gcloud builds submit --tag ${IMAGE_TAG} --project ${PROJECT_ID} ../backend
    export CONTAINER_IMAGE=${IMAGE_TAG}
else
    # Use provided image or default
    export CONTAINER_IMAGE=${CONTAINER_IMAGE:-"${REGION}-docker.pkg.dev/${PROJECT_ID}/containers/${SERVICE_NAME}:latest"}
fi

# Render the YAML template
envsubst < $(dirname $0)/cloudrun.yaml > cloudrun.rendered.yaml

# Deploy using the rendered YAML (private by default - no allUsers binding)
echo "Deploying to Cloud Run..."
gcloud run services replace cloudrun.rendered.yaml \
  --region ${REGION} \
  --project ${PROJECT_ID}

# Set service account if specified
if [ -n "${SERVICE_ACCOUNT}" ]; then
    gcloud run services update ${SERVICE_NAME} \
      --service-account ${SERVICE_ACCOUNT} \
      --region ${REGION} \
      --project ${PROJECT_ID}
fi

# Ensure authentication is required (remove allUsers binding if present)
echo "Ensuring Cloud Run service requires authentication..."
gcloud run services remove-iam-policy-binding ${SERVICE_NAME} \
  --member="allUsers" \
  --role="roles/run.invoker" \
  --region ${REGION} \
  --project ${PROJECT_ID} 2>/dev/null || echo "allUsers binding not present (already secure)"

# Grant run.invoker to the service account that WIF will impersonate
if [ -n "${SERVICE_ACCOUNT}" ]; then
    echo "Granting run.invoker role to service account..."
    gcloud run services add-iam-policy-binding ${SERVICE_NAME} \
      --member="serviceAccount:${SERVICE_ACCOUNT}" \
      --role="roles/run.invoker" \
      --region ${REGION} \
      --project ${PROJECT_ID} || echo "Invoker binding may already exist"
fi

# Get and display the service URL (needed for CLOUD_RUN_URL env var)
CLOUD_RUN_URL=$(gcloud run services describe ${SERVICE_NAME} --region ${REGION} --project ${PROJECT_ID} --format 'value(status.url)')

echo ""
echo "Deployment complete!"
echo "Service URL: ${CLOUD_RUN_URL}"
echo ""
echo "Add this to your Vercel environment variables:"
echo "  CLOUD_RUN_URL=${CLOUD_RUN_URL}"

