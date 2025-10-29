#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/../../.. && pwd)"
MANIFEST_DIR="${REPO_ROOT}/infra/gke/manifests"

: "${GKE_STATIC_IP_NAME:?GKE_STATIC_IP_NAME must be set}"
: "${GKE_DOMAIN:?GKE_DOMAIN must be set}"
: "${VLLM_GCP_SERVICE_ACCOUNT:?VLLM_GCP_SERVICE_ACCOUNT must be set}"

GKE_STORAGE_CLASS=${GKE_STORAGE_CLASS:-premium-rwo}
MODEL_CACHE_STORAGE=${MODEL_CACHE_STORAGE:-1Ti}
VLLM_REPLICAS=${VLLM_REPLICAS:-1}
GKE_GPU_TYPE=${GKE_GPU_TYPE:-nvidia-l4}
VLLM_IMAGE=${VLLM_IMAGE:-ghcr.io/vllm-project/vllm:0.10.0}
VLLM_MODEL_ID=${VLLM_MODEL_ID:-Qwen/Qwen3-8B-FP8}
MODEL_CACHE_MOUNT_PATH=${MODEL_CACHE_MOUNT_PATH:-/root/.cache/huggingface}
VLLM_GPU_LIMIT=${VLLM_GPU_LIMIT:-1}
VLLM_GPU_REQUEST=${VLLM_GPU_REQUEST:-1}
VLLM_CPU_LIMIT=${VLLM_CPU_LIMIT:-8}
VLLM_CPU_REQUEST=${VLLM_CPU_REQUEST:-4}
VLLM_MEMORY_LIMIT=${VLLM_MEMORY_LIMIT:-48Gi}
VLLM_MEMORY_REQUEST=${VLLM_MEMORY_REQUEST:-40Gi}
VLLM_EPHEMERAL_REQUEST=${VLLM_EPHEMERAL_REQUEST:-30Gi}
GKE_ARMOR_POLICY=${GKE_ARMOR_POLICY:-}

if [[ -n "${GKE_ARMOR_POLICY}" ]]; then
  BACKEND_CONFIG_ANNOTATION='{"ports":{"80":"llm-backendconfig"}}'
  INCLUDE_BACKEND_CONFIG=true
else
  BACKEND_CONFIG_ANNOTATION='{}'
  INCLUDE_BACKEND_CONFIG=false
fi

export \
  GKE_STORAGE_CLASS \
  MODEL_CACHE_STORAGE \
  VLLM_REPLICAS \
  GKE_GPU_TYPE \
  VLLM_IMAGE \
  VLLM_MODEL_ID \
  MODEL_CACHE_MOUNT_PATH \
  VLLM_GPU_LIMIT \
  VLLM_GPU_REQUEST \
  VLLM_CPU_LIMIT \
  VLLM_CPU_REQUEST \
  VLLM_MEMORY_LIMIT \
  VLLM_MEMORY_REQUEST \
  VLLM_EPHEMERAL_REQUEST \
  GKE_STATIC_IP_NAME \
  GKE_DOMAIN \
  VLLM_GCP_SERVICE_ACCOUNT \
  GKE_ARMOR_POLICY \
  BACKEND_CONFIG_ANNOTATION

render_dir="$(mktemp -d)"
trap 'rm -rf "${render_dir}"' EXIT

render() {
  local src="$1"
  local dst="${render_dir}/$(basename "$1")"
  envsubst < "$src" > "$dst"
}

for file in "${MANIFEST_DIR}"/*.yaml; do
  name="$(basename "$file")"
  if [[ "$name" == 'backendconfig.yaml' && "${INCLUDE_BACKEND_CONFIG}" != true ]]; then
    continue
  fi
  render "$file"
done

kubectl apply -f "${render_dir}/namespace.yaml"
kubectl apply -f "${render_dir}/service-account.yaml"
kubectl apply -f "${render_dir}/pvc-model-cache.yaml"

if [[ "${INCLUDE_BACKEND_CONFIG}" == true ]]; then
  kubectl apply -f "${render_dir}/backendconfig.yaml"
fi

kubectl apply -f "${render_dir}/deployment-vllm.yaml"
kubectl apply -f "${render_dir}/service-vllm.yaml"

if [[ -f "${render_dir}/managed-certificate.yaml" ]]; then
  kubectl apply -f "${render_dir}/managed-certificate.yaml"
fi

kubectl apply -f "${render_dir}/ingress.yaml"

kubectl rollout status deployment/vllm -n inference --timeout=600s

INGRESS_HOST="$(kubectl get ingress vllm -n inference -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
if [[ -z "${INGRESS_HOST}" ]]; then
  INGRESS_HOST="$(kubectl get ingress vllm -n inference -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)"
fi

if [[ -n "${INGRESS_HOST}" ]]; then
  printf 'Ingress endpoint: https://%s\n' "${INGRESS_HOST}"
else
  echo 'Ingress endpoint not yet assigned; check gcloud console.'
fi

if command -v curl >/dev/null 2>&1; then
  if [[ -n "${INGRESS_HOST}" ]]; then
    curl -fsS "https://${INGRESS_HOST}/health" || echo 'Health check failed'
  fi
fi
