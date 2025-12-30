#!/bin/bash
# deploy-cloudrun.sh
# Deploy vLLM to Cloud Run with GPU support
# Usage: ./deploy-cloudrun.sh [MODEL_ID]

set -e

# Configuration
PROJECT_ID=${PROJECT_ID:-"segov-dev-model"}
REGION=${REGION:-"us-east4"}  # Cloud Run GPU available in us-east4
SERVICE_NAME=${SERVICE_NAME:-"vllm-inference"}
SERVICE_ACCOUNT=${SERVICE_ACCOUNT:-"mcp-sa@${PROJECT_ID}.iam.gserviceaccount.com"}
ARTIFACT_REPO=${ARTIFACT_REPO:-"containers"}
MODEL_ID=${1:-"Qwen/Qwen3-8B"}
MODEL_WEIGHTS_BUCKET=${MODEL_WEIGHTS_BUCKET:-"segov-dev-model-weights"}

echo "=========================================="
echo "Deploying vLLM to Cloud Run with GPU"
echo "=========================================="
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Service: ${SERVICE_NAME}"
echo "Model: ${MODEL_ID}"
echo ""

# Check if envsubst is available
if ! command -v envsubst &> /dev/null; then
    echo "Error: envsubst is required but not found. Install gettext package."
    exit 1
fi

# Step 1: Ensure HMAC credentials exist for Run:ai Model Streamer
echo "1. Checking HMAC credentials for GCS S3-compatible access..."

# Check if HMAC secrets exist
if ! gcloud secrets describe HMAC_ACCESS_KEY --project=${PROJECT_ID} &>/dev/null; then
    echo "   HMAC secrets not found. Creating HMAC key for service account..."

    # Create HMAC key
    # Note: gsutil hmac create outputs "Access Id:" and "Secret:" (no space in "Id")
    HMAC_OUTPUT=$(gsutil hmac create ${SERVICE_ACCOUNT} 2>&1)
    ACCESS_KEY=$(echo "$HMAC_OUTPUT" | grep -E "Access.?Id:" | awk '{print $NF}')
    SECRET_KEY=$(echo "$HMAC_OUTPUT" | grep "Secret:" | awk '{print $NF}')

    if [ -z "$ACCESS_KEY" ] || [ -z "$SECRET_KEY" ]; then
        echo "   Error: Failed to create HMAC key"
        echo "$HMAC_OUTPUT"
        exit 1
    fi

    # Store in Secret Manager
    echo "   Storing HMAC credentials in Secret Manager..."
    echo -n "$ACCESS_KEY" | gcloud secrets create HMAC_ACCESS_KEY --data-file=- --project=${PROJECT_ID}
    echo -n "$SECRET_KEY" | gcloud secrets create HMAC_SECRET_KEY --data-file=- --project=${PROJECT_ID}

    echo "   HMAC credentials created and stored."
else
    echo "   HMAC secrets already exist."
fi

# Grant secret accessor to service account
echo "   Granting secret accessor role to service account..."
gcloud secrets add-iam-policy-binding HMAC_ACCESS_KEY \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor" \
    --project=${PROJECT_ID} 2>/dev/null || echo "   (binding may already exist)"
gcloud secrets add-iam-policy-binding HMAC_SECRET_KEY \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor" \
    --project=${PROJECT_ID} 2>/dev/null || echo "   (binding may already exist)"

# Step 2: Verify model weights exist in GCS bucket
echo ""
echo "2. Verifying model weights in GCS bucket..."
if gsutil ls gs://${MODEL_WEIGHTS_BUCKET}/${MODEL_ID}/ &>/dev/null; then
    echo "   Model weights found in gs://${MODEL_WEIGHTS_BUCKET}/${MODEL_ID}/"
else
    echo "   Warning: Model weights not found in gs://${MODEL_WEIGHTS_BUCKET}/${MODEL_ID}/"
    echo "   Please upload model weights before deployment."
fi

# Step 3: Create Artifact Registry repository if it doesn't exist
echo ""
echo "3. Ensuring Artifact Registry repository exists..."
if ! gcloud artifacts repositories describe ${ARTIFACT_REPO} \
    --location=${REGION} \
    --project=${PROJECT_ID} &>/dev/null; then
    echo "   Creating repository ${ARTIFACT_REPO}..."
    gcloud artifacts repositories create ${ARTIFACT_REPO} \
        --repository-format=docker \
        --location=${REGION} \
        --project=${PROJECT_ID}
else
    echo "   Repository ${ARTIFACT_REPO} already exists."
fi

# Step 4: Build and push container image
echo ""
echo "4. Building container image..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_TAG="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/${SERVICE_NAME}:$(date +%s)"

# Create Cloud Build config
CLOUDBUILD_TEMP="${SCRIPT_DIR}/.cloudbuild-vllm.yaml"
cat > "${CLOUDBUILD_TEMP}" << EOF
steps:
- name: 'gcr.io/cloud-builders/docker'
  args: ['build', '-t', '${IMAGE_TAG}', '.']
images:
- '${IMAGE_TAG}'
timeout: '1800s'
EOF

# Build from the gcp-vllm directory
echo "   Submitting build to Cloud Build..."
(cd "${SCRIPT_DIR}" && gcloud builds submit \
    --config=".cloudbuild-vllm.yaml" \
    --project=${PROJECT_ID} .)

# Cleanup
rm -f "${CLOUDBUILD_TEMP}"
echo "   Image built: ${IMAGE_TAG}"

# Step 5: Render and deploy Cloud Run service
echo ""
echo "5. Deploying to Cloud Run..."
export CONTAINER_IMAGE="${IMAGE_TAG}"
export PROJECT_ID
export REGION
export SERVICE_NAME
export SERVICE_ACCOUNT

RENDERED_YAML="${SCRIPT_DIR}/cloudrun-vllm.rendered.yaml"
envsubst < "${SCRIPT_DIR}/cloudrun-vllm.yaml" > "${RENDERED_YAML}"

gcloud run services replace "${RENDERED_YAML}" \
    --region=${REGION} \
    --project=${PROJECT_ID}

rm -f "${RENDERED_YAML}"

# Step 6: Configure IAM - Allow backend service account to invoke
echo ""
echo "6. Configuring IAM..."
gcloud run services add-iam-policy-binding ${SERVICE_NAME} \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/run.invoker" \
    --region=${REGION} \
    --project=${PROJECT_ID} 2>/dev/null || echo "   (invoker binding may already exist)"

# Step 7: Get service URL
echo ""
echo "7. Getting service URL..."
SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} \
    --region=${REGION} \
    --project=${PROJECT_ID} \
    --format='value(status.url)')

echo ""
echo "=========================================="
echo "Deployment Complete!"
echo "=========================================="
echo ""
echo "Service URL: ${SERVICE_URL}"
echo ""
echo "Next steps:"
echo "1. Update your backend's OPENAI_BASE_URL to:"
echo "   ${SERVICE_URL}/v1"
echo ""
echo "2. Update GitHub variable OPENAI_BASE_URL:"
echo "   gh variable set OPENAI_BASE_URL --body '${SERVICE_URL}/v1' --env prod"
echo ""
echo "Note: Cold start takes ~30-60 seconds with Run:ai Model Streamer (down from ~343s)."
echo ""
