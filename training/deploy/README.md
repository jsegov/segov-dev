# Stage 2 — Serve the fine-tuned Qwen on Modal + vLLM

Serves **our fine-tune**. For Qwen3.5-4B this means the **merged model**, not a
runtime LoRA adapter — see the box below. vLLM loads the merged standalone model
normally; every delta (including the linear-attention projections) is baked in.

> ### Why merged, not LoRA-on-base (load-bearing)
> Qwen3.5-4B is a **3:1 hybrid**: 8 of 32 layers are full attention
> (`q/k/v/o_proj`); the other **24 (75%) are linear attention** using a **fused**
> `in_proj_qkv`. Tinker trains **split** `in_proj_q/k/v` adapters. vLLM's LoRA
> path only recognizes the fused name, so as a runtime `--lora-modules` adapter
> it would **silently ignore** our `in_proj_q/k/v` (and `embed_tokens`) deltas
> and serve near-**base** behavior on ~75% of layers (vLLM warns-and-ignores
> unknown modules; it does not error). The merged export fuses the split deltas
> into `in_proj_qkv` at the right Q‖K‖V offsets (cookbook `_merge_qwen3_5.py`),
> so nothing is dropped. Runtime LoRA remains valid for models without this
> fused-projection mismatch; it is simply wrong here.

## 0. Prerequisite — a `sampler_weights/` checkpoint

Export needs a `sampler_weights/` path. The registry stores the `weights/` STATE
path (resume-only, not exportable); `export_adapter.py` derives the
`sampler_weights` sibling automatically. If it was never written for the run,
`download` fails after retries — create a training client from the state and call
`save_weights_for_sampler`, then pass that `checkpoint=` explicitly.

## 1. Export the MERGED model (local, needs `TINKER_API_KEY`)

```bash
cd training
TINKER_API_KEY=… uv run python -m ama_training.export_adapter \
    preset=qwen3.5-4b merged=true output=data/adapters/qwen3.5-4b-merged
# → a standalone ~9.3 GB HF model directory (weights + tokenizer + config)
```

Two operational gotchas (both handled/expected, noted so they don't alarm):

- **Flaky first archive build.** Tinker builds the downloadable archive
  server-side on first request; that build can take several minutes and time
  out the client ("Creating checkpoint archive … still running" then "Failed to
  get download URL"). This does NOT mean the checkpoint is missing — each attempt
  advances the build until it caches. `export_adapter` retries with backoff
  (5×20s); a manual re-run also works once the archive is warm. Liveness is
  independently confirmable with `create_sampling_client(model_path=…/sampler_weights/final)`.
- **Base weights download.** The merge pulls the ~9.3 GB base model from HF (to
  fuse the deltas into base weights); unauthenticated HF is rate-limited and slow.
  Set `HF_TOKEN` to speed it up. Cached under `~/.cache/huggingface`, so one-time.
  The merge itself needs enough RAM to hold the model (fits on a 16 GB+ machine;
  it can also run on Modal if local RAM is short).
- **Telemetry hang.** Tinker's async telemetry can hit a retry storm (422 on a
  malformed session_id) that starves the download's event loop and hangs the
  export at 0% CPU. `export_adapter` defaults `TINKER_TELEMETRY=0` to avoid it;
  if you invoke the SDK directly, set that env var yourself.

The ~292 MB PEFT adapter (`merged=false`, the default) is kept documented for
reuse on other models, but is NOT what we serve for Qwen3.5 (see the box).

## 2. Stage the merged model into a Modal Volume

```bash
modal volume create ama-merged
modal volume put ama-merged ./data/adapters/qwen3.5-4b-merged /qwen   # → /models/qwen at serve
```

## 3. Deploy

```bash
modal deploy deploy/modal_app.py     # `deploy`, not `run` (snapshots/URL need deploy)
```

Endpoint is authenticated by Modal proxy auth. The AI SDK reuses the existing
`AMA_INFERENCE_BASE_URL` seam:

```
AMA_INFERENCE_BASE_URL = https://<workspace>--ama-vllm-amavllm-serve.modal.run/v1
AMA_DEPLOYMENT_MODEL   = ama
AMA_INFERENCE_API_KEY  = <MODAL_KEY_ID>.<MODAL_KEY_SECRET>   # wk-….ws-…, joined by a dot
```

## Deploy gates — each proves we serve the fine-tune faithfully

1. **Merge integrity / module coverage.** With the merged model this is largely
   moot (deltas are in the weights, not runtime LoRA), but sanity-check anyway:
   the merged dir loads in vLLM without shape/key errors, and — belt and
   suspenders — grep the startup log for "will be ignored" / "not in supported
   LoRA target modules" (should be silent; there is no LoRA at serve). The merge
   itself is the real check: it must fuse `in_proj_q/k/v → in_proj_qkv` (24
   layers), `in_proj_z`, `out_proj`, full-attn, MLP, and `embed_tokens` — verify
   the output config has the canonical fused `in_proj_qkvz`/`in_proj_ba` layout.
2. **No thinking leak.** `curl` a scope-refusal prompt; assert no `<think>` in
   `content` (the exact Tinker-endpoint failure this config fixes).
3. **Render parity.** Diff **token IDs** from the tinker `qwen3_5_disable_thinking`
   renderer vs vLLM's `/tokenize` (with `enable_thinking=false`) over a battery
   (system+tools, user, assistant tool_call, `role:tool` result, multi-turn).
   Nonzero → set `CUSTOM_CHAT_TEMPLATE` to a training-matched Jinja and re-diff.
4. **Behavioral parity.** Same prompts through `ama_training.sample` (our
   checkpoint, train-identical render) vs the Modal endpoint → outputs match.
   This is the decisive "is this our fine-tune?" test — it directly catches any
   merge that dropped deltas.
5. **Serving contract.** Stable `tool_call.id`, incremental deltas, valid JSON
   args (qwen3_xml type-casting is the risky one), `finish_reason:"tool_calls"`,
   `role:"tool"` round-trip, streaming usage, no XML in content.
6. **Full eval.** Point `AMA_INFERENCE_BASE_URL` at this endpoint and run
   `pnpm --filter frontend eval:ama` — the fair 150-case qwen number the Tinker
   OAI endpoint couldn't give. Gate vs. inkling 143/150 and the Sol baseline.

## Version-sensitive — re-verify before trusting

- `vllm==0.21.0` pin and every flag (`--tool-call-parser qwen3_xml`,
  `--reasoning-parser qwen3`, `--default-chat-template-kwargs`,
  `--language-model-only`). Parser names change between releases;
  `enable_thinking:false`+tools was broken pre-0.9 / vLLM #35574.
- Qwen3.5 loads correctly in the pinned vLLM (hybrid linear-attention support is
  relatively recent — vLLM Qwen3-Next lineage).
- `@modal.web_server` / `@modal.concurrent` API and `nvidia/cuda:12.9.0` base in
  your installed `modal` version.
- L4 per-second price; GPU memory snapshots (cold-start mitigation) are
  experimental — verify L4 support before enabling.
