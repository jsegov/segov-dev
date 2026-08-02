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
  under eager mode).
- Snapshots build over the first 2-3 cold boots after EVERY deploy; those
  stay slow. Don't judge cold-start latency until ~boot 4.
- GPU snapshots are alpha and gated on NVIDIA driver 570+; official examples
  use A10/H100 — L4 support is UNVERIFIED. If snapshot creation fails on L4,
  switch gpu="L4" -> "A10" (same 24GB class, snapshot-proven).

Modal deployment script, run with the `modal` CLI (installed separately from
this repo's uv project) — NOT under `uv run`:

    # stage the ~9.3GB merged model (from export_adapter merged=true) into a Volume
    modal volume create ama-merged
    modal volume put ama-merged ./data/adapters/qwen3.5-4b-merged /qwen

    # deploy (`deploy`, not `run` — snapshots/stable URL need deploy)
    modal deploy deploy/modal_app.py

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

# --- Serving identity ---------------------------------------------------------
# The merged standalone model, staged into the ama-merged Volume (mount below).
MERGED_MODEL_DIR = "/models/qwen"  # = <volume mount>/qwen from `modal volume put`
SERVED_NAME = "ama"  # the model id the AI SDK requests
MAX_MODEL_LEN = 8192
VLLM_PORT = 8000
VLLM_BASE = f"http://127.0.0.1:{VLLM_PORT}"

# vLLM moves fast and parser names change between releases — pin explicitly and
# re-verify the flags against this version (see deploy/README.md version notes).
VLLM_VERSION = "0.21.0"

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
    modal.Image.from_registry(
        "nvidia/cuda:12.9.0-devel-ubuntu22.04", add_python="3.12"
    )
    .entrypoint([])
    .uv_pip_install(f"vllm=={VLLM_VERSION}")
    .env(
        {
            # Exposes vLLM's /sleep and /wake_up endpoints (sleep-mode control).
            "VLLM_SERVER_DEV_MODE": "1",
            # Multi-threaded inductor compiles break Modal snapshot creation.
            "TORCHINDUCTOR_COMPILE_THREADS": "1",
        }
    )
)

app = modal.App("ama-vllm")

# The merged model is self-contained (weights + tokenizer + config), so serving
# needs no HF download — just this Volume. vllm-cache persists torch.compile
# artifacts, which matters on the slow first boots after a redeploy (before the
# snapshot exists).
merged_volume = modal.Volume.from_name("ama-merged", create_if_missing=True)
vllm_cache = modal.Volume.from_name("vllm-cache", create_if_missing=True)

VOLUMES = {
    "/models": merged_volume,
    "/root/.cache/vllm": vllm_cache,
}


def _wait_for_vllm(timeout_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
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


@app.cls(
    image=vllm_image,
    gpu="L4",  # 9.3GB weights + runtime + 8K KV << 24GB; if GPU snapshots fail
    #           on L4 (unverified, driver-570 gate), switch to "A10".
    volumes=VOLUMES,
    # 60s (the default) is chat-hostile: a visitor who pauses 2 minutes to read
    # an answer eats a cold start mid-conversation. 10 min idle on an L4 costs
    # pennies at personal-site traffic; Modal's own vLLM examples use 5-15 min.
    scaledown_window=10 * 60,
    timeout=10 * 60,
    # GPU memory snapshots (alpha): checkpoint the fully-booted engine so cold
    # starts become restores. min_containers=1 (~$580/mo) stays not-worth-it.
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
)
@modal.concurrent(max_inputs=8)  # low-traffic personal site; not 100
class AmaVllm:
    @modal.enter(snap=True)
    def start_vllm(self) -> None:
        """Boot + warm vLLM, then sleep it — this state gets snapshotted."""
        cmd = [
            "vllm", "serve", MERGED_MODEL_DIR,
            "--served-model-name", SERVED_NAME,
            "--max-model-len", str(MAX_MODEL_LEN),
            # --- tool calling: qwen3_xml matches our trained XML wire format and
            #     is the streaming-robust parser (qwen3_coder is the fallback) ---
            "--enable-auto-tool-choice",
            "--tool-call-parser", "qwen3_xml",
            # --- non-thinking, two layers: reasoning-parser routes any stray
            #     <think> out of content; the server-default kwarg injects the
            #     empty <think></think> so the model emits none (client can't
            #     re-enable it) ---
            "--reasoning-parser", "qwen3",
            "--default-chat-template-kwargs", '{"enable_thinking": false}',
            # --- text-only: skip the vision tower, free memory for KV cache ---
            "--language-model-only",
            "--enable-force-include-usage",  # streaming usage metadata for the AI SDK
            # --- snapshot-era boot config: full compilation (paid once, at
            #     snapshot creation), CUDA graphs only at our real batch sizes
            #     (max_inputs=8), and headroom for snapshot restore ---
            "--compilation-config", '{"cudagraph_capture_sizes": [1, 2, 4, 8]}',
            "--gpu-memory-utilization", "0.85",
            "--enable-sleep-mode",
            "--port", str(VLLM_PORT),
        ]
        if CUSTOM_CHAT_TEMPLATE:
            cmd += ["--chat-template", CUSTOM_CHAT_TEMPLATE]
        print("launching:", " ".join(cmd))
        subprocess.Popen(cmd)
        _wait_for_vllm(timeout_s=10 * 60)
        # Warm the compiled paths so they're inside the snapshot, not paid by
        # the first visitor.
        for _ in range(2):
            _post(
                "/v1/chat/completions",
                {
                    "model": SERVED_NAME,
                    "messages": [{"role": "user", "content": "warmup"}],
                    "max_tokens": 8,
                },
                timeout=300,
            )
        # Level 1: weights offload to CPU RAM (snapshottable), meaningless
        # warmup KV cache is discarded. Level 2 would discard the weights.
        _post("/sleep?level=1", timeout=300)
        print("vLLM warmed and sleeping; snapshot will capture this state")

    @modal.enter(snap=False)
    def wake_vllm(self) -> None:
        """After snapshot restore (or on non-snapshot boots), wake the engine."""
        _post("/wake_up", timeout=300)
        print("vLLM awake")

    # requires_proxy_auth: Modal's edge rejects unauthenticated requests BEFORE
    # a container starts — without it this is a public URL where every scraper
    # hit pays a GPU cold start. Proxy auth is NOT Bearer: clients must send
    # `Modal-Key: wk-...` and `Modal-Secret: ws-...` headers (a proxy-auth token
    # pair from the Modal dashboard). The AI SDK sends them via
    # AMA_INFERENCE_HEADERS — see deploy/README.md.
    #
    # startup_timeout covers the un-snapshotted boots (weight load + full
    # torch.compile); snapshot restores are seconds.
    @modal.web_server(port=VLLM_PORT, startup_timeout=15 * 60, requires_proxy_auth=True)
    def serve(self) -> None:
        """vLLM is started in start_vllm (must pre-exist the snapshot)."""
