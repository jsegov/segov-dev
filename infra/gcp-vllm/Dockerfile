# vLLM Cloud Run GPU Dockerfile
# This image runs vLLM with the Qwen3-8B model on Cloud Run with L4 GPU

FROM vllm/vllm-openai:v0.9.0

# Install Run:ai Model Streamer extension for faster model loading from GCS
# This streams model weights directly to GPU memory instead of downloading to disk
RUN pip install vllm[runai]

# Force unbuffered output for Cloud Run logging
ENV PYTHONUNBUFFERED=1

# vLLM runs on port 8000 by default
EXPOSE 8000

# Configuration notes:
# - Model loaded from GCS via S3-compatible API using Run:ai streamer
# - HMAC credentials injected via Secret Manager at runtime
# - max-model-len=8192: Safe for L4 24GB VRAM (Qwen3-8B base ~15GB)
# - gpu-memory-utilization=0.90: Leave 10% headroom for stability
# - tool-call-parser=hermes: Qwen3 uses Hermes-style tool calling
# - load-format=runai_streamer: Streams tensors directly to GPU
# - concurrency=8: Conservative parallel S3 connections (reduced from 16 for stability)
#
# NOTE: --reasoning-parser=qwen3 was removed due to a known bug in vLLM v0.9.0
# where streaming with implicit enable_thinking=False causes the function call
# parser to fail. See: https://github.com/vllm-project/vllm/issues/17655

# Create entrypoint script to construct model path from environment variables
RUN cat > /entrypoint.sh << 'EOF'
#!/bin/bash
MODEL_ID=${MODEL_ID:-"Qwen/Qwen3-8B"}
MODEL_WEIGHTS_BUCKET=${MODEL_WEIGHTS_BUCKET:-"segov-dev-model-weights"}
MODEL_PATH="s3://${MODEL_WEIGHTS_BUCKET}/${MODEL_ID}"

exec vllm serve "$MODEL_PATH" \
  --load-format runai_streamer \
  --model-loader-extra-config "{\"concurrency\":8}" \
  --dtype bfloat16 \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.90 \
  --trust-remote-code \
  --enforce-eager \
  --enable-auto-tool-choice \
  --tool-call-parser hermes \
  --host 0.0.0.0 \
  --port 8000
EOF

RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
