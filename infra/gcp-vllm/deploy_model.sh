#!/bin/bash
# deploy_model.sh
# Usage: ./deploy_model.sh <HUGGING_FACE_TOKEN> [MODEL_ID]

HF_TOKEN=$1
MODEL_ID=${2:-"Qwen/Qwen3-8B"} # Default to Qwen3-8B if not specified

if [ -z "$HF_TOKEN" ]; then
    echo "Error: Hugging Face Token required for model access."
    echo "Usage: ./deploy_model.sh <token> [model_id]"
    exit 1
fi

IMAGE_TAG="vllm/vllm-openai:v0.9.0"
CONTAINER_NAME="vllm-service"
PORT=8000

EXTRA_ARGS=""
if [[ "$MODEL_ID" == *"Qwen3"* ]]; then
    echo "[INFO] Configuring for Qwen3..."
    EXTRA_ARGS="--enable-reasoning --reasoning-parser qwen3"
fi

echo "[INFO] Pulling Docker Image: $IMAGE_TAG..."
docker pull $IMAGE_TAG

# Check and remove existing container
if [ "$(docker ps -aq -f name=$CONTAINER_NAME)" ]; then
    echo "[INFO] Stopping existing container..."
    docker stop $CONTAINER_NAME
    docker rm $CONTAINER_NAME
fi

echo "[INFO] Launching container for model: $MODEL_ID..."

docker run -d \
    --name $CONTAINER_NAME \
    --runtime nvidia \
    --gpus all \
    --ipc=host \
    -p $PORT:8000 \
    -v ~/hf_cache:/root/.cache/huggingface \
    -e HUGGING_FACE_HUB_TOKEN=$HF_TOKEN \
    $IMAGE_TAG \
    --model $MODEL_ID \
    --dtype bfloat16 \
    --tensor-parallel-size 1 \
    --max-model-len 16384 \
    --gpu-memory-utilization 0.95 \
    --trust-remote-code \
    --enforce-eager \
    --disable-log-stats \
    --enable-auto-tool-choice \
    --tool-call-parser hermes \
    $EXTRA_ARGS

echo "[INFO] Waiting for container to be healthy..."

sleep 10

max_attempts=60
attempt=0

while [ $attempt -lt $max_attempts ]; do
  if curl -f -s http://localhost:$PORT/health > /dev/null 2>&1; then
    echo "[INFO] Container is ready."
    exit 0
  fi
  
  attempt=$((attempt + 1))
  sleep 10
done

echo "[ERROR] Container did not become healthy within timeout period."
docker logs --tail 50 $CONTAINER_NAME 2>&1
exit 1
