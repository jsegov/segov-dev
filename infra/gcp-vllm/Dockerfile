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
# - tool-call-parser=hermes: Qwen3 uses Hermes-style tool calling
#
# NOTE: --reasoning-parser=qwen3 was removed due to a known bug in vLLM v0.9.0
# where streaming with implicit enable_thinking=False causes the function call
# parser to fail. See: https://github.com/vllm-project/vllm/issues/17655
# The fix (PR #19135) requires CUDA 12.9+ which is incompatible with Cloud Run's
# driver 535 (CUDA 12.2). Removing the reasoning parser resolves the issue.
CMD ["--model", "Qwen/Qwen3-8B", "--dtype", "bfloat16", "--max-model-len", "8192", "--gpu-memory-utilization", "0.90", "--trust-remote-code", "--enforce-eager", "--enable-auto-tool-choice", "--tool-call-parser", "hermes", "--host", "0.0.0.0", "--port", "8000"]
