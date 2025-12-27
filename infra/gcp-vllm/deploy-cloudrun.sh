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

# Step 1: Ensure HF_TOKEN secret exists in Secret Manager
echo "1. Checking HF_TOKEN secret in Secret Manager..."
if ! gcloud secrets describe HF_TOKEN --project=${PROJECT_ID} &>/dev/null; then
    echo "   HF_TOKEN secret not found. Creating..."
    if [ -z "${HF_TOKEN}" ]; then
        echo "   Error: HF_TOKEN environment variable must be set to create the secret."
        echo "   Run: export HF_TOKEN=your_hugging_face_token"
        exit 1
    fi
    echo -n "${HF_TOKEN}" | gcloud secrets create HF_TOKEN \
        --data-file=- \
        --project=${PROJECT_ID}
    echo "   HF_TOKEN secret created."
else
    echo "   HF_TOKEN secret already exists."
fi

# Grant secret accessor to service account
echo "   Granting secret accessor role to service account..."
gcloud secrets add-iam-policy-binding HF_TOKEN \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor" \
    --project=${PROJECT_ID} 2>/dev/null || echo "   (binding may already exist)"

# Step 2: Create Artifact Registry repository if it doesn't exist
echo ""
echo "2. Ensuring Artifact Registry repository exists..."
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

# Step 3: Build and push container image
echo ""
echo "3. Building container image..."
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

# Step 4: Render and deploy Cloud Run service
echo ""
echo "4. Deploying to Cloud Run..."
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

# Step 5: Configure IAM - Allow backend service account to invoke
echo ""
echo "5. Configuring IAM..."
gcloud run services add-iam-policy-binding ${SERVICE_NAME} \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/run.invoker" \
    --region=${REGION} \
    --project=${PROJECT_ID} 2>/dev/null || echo "   (invoker binding may already exist)"

# Step 6: Get service URL
echo ""
echo "6. Getting service URL..."
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
echo "Note: Cold start may take 30-60 seconds for initial model loading."
echo ""
