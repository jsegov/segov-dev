"""Serve the fine-tuned AMA Qwen checkpoint on Modal with vLLM (Stage 2).

Serves *our* fine-tune. For Qwen3.5-4B this MUST be the MERGED model, not a
runtime LoRA adapter: Qwen3.5 is a 3:1 hybrid whose 24/32 linear-attention
layers use a FUSED `in_proj_qkv`, but our Tinker adapter trained SPLIT
`in_proj_q/k/v`. vLLM's LoRA path only recognizes the fused name, so it would
silently ignore the split deltas (and `embed_tokens`) and serve near-BASE
behavior on ~75% of layers. The merged-HF export (`export_adapter merged=true`)
fuses every delta into the weights via the cookbook's Qwen3.5 merge, producing a
standalone model vLLM loads normally — so nothing is dropped. See deploy/README.md.

(Runtime `--lora-modules` serving is viable for models WITHOUT the fused-
projection mismatch; it is simply wrong for this one.)

COLD STARTS — GPU memory snapshots + vLLM sleep mode (Modal's lfm_snapshot
recipe). vLLM boots in `@modal.enter(snap=True)`: launch, warm up, then
`POST /sleep?level=1` (weights to CPU RAM, junk KV cache discarded) so the
snapshot captures a fully-initialized engine. After restore, `snap=False` wakes
it. This replaces the whole boot — import, CUDA init, weight load, compile,
graph capture — with a restore (measured elsewhere: 3B ~118s -> ~12s median).
Consequences baked in below:
- NO `--enforce-eager`: compile + CUDA-graph cost is paid once at snapshot
  creation, and eager costs ~3x decode throughput on a small model. This also
  makes the persisted /root/.cache/vllm compile cache meaningful (it is inert
  under eager mode). The cache Volume is deployment-specific because changing
  or deleting Volume files does not invalidate a Modal memory snapshot and can
  make a restored process reference files that no longer exist.
- Snapshots build over the first 2-3 cold boots after EVERY deploy; those
  stay slow. Don't judge cold-start latency until ~boot 4.
- GPU snapshots are alpha and gated on NVIDIA driver 570+; official examples
  use A10/H100 — L4 support is UNVERIFIED. If snapshot creation fails on L4,
  switch gpu="L4" -> "A10" (same 24GB class, snapshot-proven).

Modal deployment script, run with the SDK pinned by this repo's uv lockfile:

    # stage the ~9.3GB merged model (from export_adapter merged=true) into a Volume
    uv run modal volume create ama-merged
    uv run modal volume put ama-merged ./data/adapters/qwen3.5-4b-merged /qwen

    # deploy (`deploy`, not `run` — snapshots/stable URL need deploy)
    uv run modal deploy deploy/modal_app.py

The correctness flags fix the render gap that made the Tinker OAI-endpoint eval
meaningless (thinking ON, no reasoning parser, CoT leaking into content). Here we
own the template and flags: thinking is disabled at two layers and the tool-call
parser matches our trained XML wire format.

DEPLOY GATES (deploy/README.md): (1) no ignored-module warnings — moot for the
merged model but grep anyway; (2) no `<think>` in content; (3) token-ID render
parity vs the tinker qwen3_5_disable_thinking renderer; (4) behavioral parity vs
`ama_training.sample`; (5) full 150-case AMA eval via AMA_INFERENCE_BASE_URL.
"""

import json
import subprocess
import time
import urllib.error
import urllib.request

import modal
from ama_training.serving_identity import (
    VLLM_VERSION,
    MAX_CONCURRENT_INPUTS,
    build_server_command,
)

# --- Serving identity ---------------------------------------------------------
# The merged standalone model, staged into the ama-merged Volume (mount below).
MERGED_MODEL_DIR = "/models/qwen"  # = <volume mount>/qwen from `modal volume put`
SERVED_NAME = "ama"  # the model id the AI SDK requests
VLLM_PORT = 8000
VLLM_BASE = f"http://127.0.0.1:{VLLM_PORT}"

# vLLM moves fast and parser names change between releases — pin explicitly and
# re-verify the flags against this version (see deploy/README.md version notes).
# Treat this cache as immutable while this deployment is live. Bump the suffix
# when changing vLLM, the model, or compilation flags instead of clearing files
# in place; Modal snapshots do not track Volume mutations.
VLLM_CACHE_VOLUME_NAME = "ama-vllm-cache-v0210-qwen35-4b-32k-v1"

VLLM_ENV = {
    # Exposes vLLM's /sleep and /wake_up endpoints (sleep-mode control).
    "VLLM_SERVER_DEV_MODE": "1",
    # Multi-threaded inductor compiles break Modal snapshot creation.
    "TORCHINDUCTOR_COMPILE_THREADS": "1",
    # A Modal restore can leave PyTorch's snapshotted TCPStore connection stale.
    # A world-size-1 server has no peer ranks to coordinate diagnostic dumps
    # with, so disable only that store poll while retaining the NCCL watchdog
    # and heartbeat monitor.
    "TORCH_NCCL_DUMP_ON_TIMEOUT": "0",
}

# Training-matched template (deploy/chat_template_parity.jinja, staged on the
# ama-merged Volume). The stock template diverged from the tinker renderer at
# token 20: it dumps tools OpenAI-wrapped ({"type":"function","function":...})
# and unescaped, where training rendered them bare and ascii-escaped
# (json.dumps defaults), and it dropped the blank-content separator before
# <tool_call> in history turns. The parity template fixes all three; rendered
# strings are byte-identical to training (sole residue: one whitespace BPE
# merge in tool-call history turns — chunked vs one-shot tokenization).
CUSTOM_CHAT_TEMPLATE: str | None = "/models/chat_template_parity.jinja"

vllm_image = (
    modal.Image.from_registry("nvidia/cuda:12.9.0-devel-ubuntu22.04", add_python="3.12")
    .entrypoint([])
    .uv_pip_install(f"vllm=={VLLM_VERSION}", "rfc8785==0.1.4")
    .env(VLLM_ENV)
    .add_local_python_source("ama_training")
)

app = modal.App("ama-vllm")

# The merged model is self-contained (weights + tokenizer + config), so serving
# needs no HF download — just this Volume. A deployment-specific cache persists
# torch.compile artifacts across the 2-3 snapshot-building boots without
# allowing an unrelated deployment to mutate paths captured by this snapshot.
merged_volume = modal.Volume.from_name("ama-merged", create_if_missing=True)
vllm_cache = modal.Volume.from_name(VLLM_CACHE_VOLUME_NAME, create_if_missing=True)

VOLUMES = {
    "/models": merged_volume,
    "/root/.cache/vllm": vllm_cache,
}


def _wait_for_vllm(process: subprocess.Popen, timeout_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if (return_code := process.poll()) is not None:
            raise subprocess.CalledProcessError(return_code, process.args)
        try:
            with urllib.request.urlopen(f"{VLLM_BASE}/health", timeout=5) as resp:
                if resp.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(2)
    raise RuntimeError(f"vLLM did not become healthy within {timeout_s}s")


def _post(path: str, payload: dict | None = None, timeout: float = 120) -> None:
    body = json.dumps(payload).encode() if payload is not None else b""
    req = urllib.request.Request(
        f"{VLLM_BASE}{path}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        resp.read()


def _get_json(path: str, timeout: float = 30) -> object:
    with urllib.request.urlopen(f"{VLLM_BASE}{path}", timeout=timeout) as resp:
        return json.load(resp)


def _is_vllm_sleeping(payload: object) -> bool:
    """Read vLLM's sleep-state response without accepting ambiguous values."""
    # Current vLLM returns {"is_sleeping": bool}. Retain bare-bool support for
    # older/custom OpenAI-compatible servers, but fail closed on malformed JSON
    # instead of treating a truthy response object as "still sleeping" forever.
    if isinstance(payload, bool):
        return payload
    if isinstance(payload, dict):
        is_sleeping = payload.get("is_sleeping")
        if isinstance(is_sleeping, bool):
            return is_sleeping
    raise ValueError("vLLM /is_sleeping returned an invalid response")


def _wait_for_serving_ready(process: subprocess.Popen, timeout_s: float) -> None:
    """Gate external traffic on a restored engine that can generate tokens."""
    deadline = time.monotonic() + timeout_s
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if (return_code := process.poll()) is not None:
            raise subprocess.CalledProcessError(return_code, process.args)

        try:
            if _is_vllm_sleeping(_get_json("/is_sleeping", timeout=5)):
                raise RuntimeError("vLLM is still sleeping")
            with urllib.request.urlopen(f"{VLLM_BASE}/health", timeout=5) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"vLLM health returned HTTP {resp.status}")
            _post(
                "/v1/chat/completions",
                {
                    "model": SERVED_NAME,
                    "messages": [{"role": "user", "content": "readiness"}],
                    "max_tokens": 1,
                    "temperature": 0,
                    "seed": 1,
                },
                timeout=30,
            )
            return
        except (
            json.JSONDecodeError,
            TimeoutError,
            urllib.error.URLError,
            ConnectionError,
            OSError,
            RuntimeError,
        ) as error:
            last_error = error
            time.sleep(2)

    raise RuntimeError(f"vLLM did not become serving-ready within {timeout_s}s") from last_error


# app.server exposes the process directly and returns 503 while a scale-to-zero
# container is restoring. Unlike @modal.web_server, it does not hold each HTTP
# request against the 150-second web-function limit. Authentication remains on
# because unauthenticated defaults to False; clients use Modal-Key/Modal-Secret.
@app.server(
    image=vllm_image,
    gpu="L4",  # 9.3GB weights + runtime + bounded KV cache target 24GB. If GPU
    #           snapshots fail on L4 (unverified), switch to "A10".
    volumes=VOLUMES,
    # 60s (the default) is chat-hostile: a visitor who pauses 2 minutes to read
    # an answer eats a cold start mid-conversation. 10 min idle on an L4 costs
    # pennies at personal-site traffic; Modal's own vLLM examples use 5-15 min.
    scaledown_window=10 * 60,
    min_containers=0,
    target_concurrency=MAX_CONCURRENT_INPUTS,
    port=VLLM_PORT,
    startup_timeout=15 * 60,
    exit_grace_period=30,
    # GPU memory snapshots (alpha): checkpoint the fully-booted engine so cold
    # starts become restores. min_containers=1 (~$580/mo) stays not-worth-it.
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
)
class AmaVllm:
    @modal.enter(snap=True)
    def start_vllm(self) -> None:
        """Boot + warm vLLM, then sleep it — this state gets snapshotted."""
        if not CUSTOM_CHAT_TEMPLATE:
            raise ValueError("A verified chat template is required")
        # Shared command construction binds advertised identities to actual flags.
        # Verify every model file before starting the snapshotted process.
        cmd = build_server_command(MERGED_MODEL_DIR, CUSTOM_CHAT_TEMPLATE, VLLM_PORT, SERVED_NAME)
        print("launching:", " ".join(cmd))
        self.process = subprocess.Popen(cmd)
        _wait_for_vllm(self.process, timeout_s=10 * 60)
        # Warm the compiled paths so they're inside the snapshot, not paid by
        # the first visitor.
        for _ in range(2):
            _post(
                "/v1/chat/completions",
                {
                    "model": SERVED_NAME,
                    "messages": [{"role": "user", "content": "warmup"}],
                    "max_tokens": 8,
                    "temperature": 0,
                    "seed": 1,
                },
                timeout=300,
            )
        # Level 1: weights offload to CPU RAM (snapshottable), meaningless
        # warmup KV cache is discarded. Level 2 would discard the weights.
        _post("/sleep?level=1", timeout=300)
        print("vLLM warmed and sleeping; snapshot will capture this state")

    @modal.enter(snap=False)
    def wake_vllm(self) -> None:
        """After restore, wake and prove the engine can serve a token."""
        process = getattr(self, "process", None)
        if process is None:
            raise RuntimeError("snapshotted vLLM process is missing")

        _post("/wake_up", timeout=300)
        _wait_for_serving_ready(process, timeout_s=5 * 60)
        print("vLLM awake and serving-ready")

    @modal.exit()
    def stop_vllm(self) -> None:
        """Terminate the snapshotted server process during container shutdown."""
        process = getattr(self, "process", None)
        if process is None or process.poll() is not None:
            return

        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
