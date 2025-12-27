# vLLM Cloud Run GPU Dockerfile
# This image runs vLLM with the Qwen3-8B model on Cloud Run with L4 GPU

FROM vllm/vllm-openai:v0.9.0

# vLLM runs on port 8000 by default
EXPOSE 8000

# Use the default vllm serve entrypoint with model arguments
# Note: HUGGING_FACE_HUB_TOKEN is injected via Secret Manager at runtime
#
# Configuration notes:
# - max-model-len=8192: Safe for L4 24GB VRAM (Qwen3-8B base ~15GB)
# - gpu-memory-utilization=0.90: Leave 10% headroom for stability
# - reasoning-parser=qwen3: Enables reasoning (--enable-reasoning deprecated in v0.9.0)
# - tool-call-parser=hermes: Qwen3 uses Hermes-style tool calling
CMD ["--model", "Qwen/Qwen3-8B", "--dtype", "bfloat16", "--max-model-len", "8192", "--gpu-memory-utilization", "0.90", "--trust-remote-code", "--enforce-eager", "--enable-auto-tool-choice", "--tool-call-parser", "hermes", "--reasoning-parser", "qwen3", "--host", "0.0.0.0", "--port", "8000"]
