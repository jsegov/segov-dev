#!/usr/bin/env bash
set -euo pipefail

# Deploy CoreWeave LLM infrastructure: Traefik, cert-manager, vLLM + Qwen3-8B-FP8
# This script performs idempotent deployment of all required components.

# Required environment variables
: "${COREWEAVE_ORG_ID:?COREWEAVE_ORG_ID must be set}"
: "${COREWEAVE_CLUSTER_NAME:?COREWEAVE_CLUSTER_NAME must be set}"

echo "Starting CoreWeave LLM infrastructure deployment..."
echo "Cluster: ${COREWEAVE_CLUSTER_NAME}"
echo "Org ID: ${COREWEAVE_ORG_ID}"

# Add CoreWeave Helm repository
echo "Adding CoreWeave Helm repository..."
helm repo add coreweave https://charts.core-services.ingress.coreweave.com || true
helm repo update

# Install Traefik Ingress Controller
echo "Installing Traefik Ingress Controller..."
helm upgrade --install traefik coreweave/traefik \
  --namespace traefik --create-namespace \
  --wait

# Install cert-manager for TLS certificates
echo "Installing cert-manager..."
helm upgrade --install cert-manager coreweave/cert-manager \
  --namespace cert-manager --create-namespace \
  --wait

# Enable cert-manager issuers
echo "Enabling cert-manager issuers..."
helm upgrade cert-manager coreweave/cert-manager \
  --namespace cert-manager \
  --set cert-issuers.enabled=true \
  --wait

# Create inference namespace
echo "Creating inference namespace..."
kubectl create namespace inference 2>/dev/null || true

# Apply model cache PVC
echo "Applying HuggingFace model cache PVC..."
kubectl apply -f infra/manifests/huggingface-model-cache-pvc.yaml

# Prepare Helm values with environment variable substitution
echo "Preparing Helm values..."
export COREWEAVE_ORG_ID COREWEAVE_CLUSTER_NAME
VALUES_TMP=$(mktemp)
envsubst < infra/helm-values/vllm-qwen-values.yaml > "$VALUES_TMP"

# Deploy vLLM inference service with Qwen3-8B-FP8
echo "Deploying vLLM inference service..."
helm upgrade --install basic-inference coreweave/vllm-inference \
  --namespace inference --create-namespace \
  -f "$VALUES_TMP" \
  --wait

# Clean up temporary values file
rm -f "$VALUES_TMP"

# Wait for deployment to be ready
echo "Waiting for vLLM deployment to be ready..."
kubectl rollout status deploy/basic-inference -n inference --timeout=600s

# Get ingress hostname
INFER_HOST=$(kubectl get ingress basic-inference -n inference -o=jsonpath='{.spec.rules[0].host}' 2>/dev/null || echo "")

if [ -n "$INFER_HOST" ]; then
  echo "✓ Deployment complete!"
  echo "vLLM endpoint: https://$INFER_HOST"
  echo ""
  echo "Testing health endpoint..."
  curl -fsS "https://$INFER_HOST/health" && echo "✓ Health check passed" || echo "✗ Health check failed"
else
  echo "Warning: Could not retrieve ingress hostname"
fi

echo ""
echo "Deployment complete. View status with:"
echo "  kubectl get pods -n inference"
echo "  kubectl get ingress -n inference"

