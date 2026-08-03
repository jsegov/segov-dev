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
modal volume put ama-merged ./data/adapters/qwen3.5-4b-merged-1gb /qwen  # → /models/qwen at serve
modal volume put ama-merged deploy/chat_template_parity.jinja /chat_template_parity.jinja
```

**Slow-uplink gotchas (all hit for real on a ~900KB/s residential uplink):**

- **Re-shard to ~1GB files first.** Modal presigns the S3/R2 part-upload URLs
  once per batch with limited validity (observed ~1h per file / 4h per batch);
  a 5GB shard that takes >1h to send fails deterministically with
  `ExpiredToken`/`ExpiredRequest`. The `-1gb` directory is the same model
  re-sharded into 10 ~1GB safetensors (index rebuilt, every tensor verified
  bit-identical) so each file clears the window. vLLM doesn't care about
  shard count.
- The modal client also hardcodes `VOLUME_PUT_FILE_CLIENT_TIMEOUT = 1h`
  per file — another reason big shards can't work on slow links.
- **Retries are cheap:** blobs are content-addressed server-side, so shards
  that completed in a failed attempt are skipped on the next one. Wrap the
  upload in a retry loop and let it converge; nothing commits to the volume
  until the whole batch succeeds.
- Run the upload under `caffeinate` (macOS) — lid-close killed one attempt.

## 3. Deploy

```bash
modal deploy deploy/modal_app.py     # `deploy`, not `run` (snapshots/URL need deploy)
```

### Cold starts — GPU memory snapshots + vLLM sleep mode

The app scales to zero and mitigates cold starts with Modal's GPU memory
snapshot recipe (their official `lfm_snapshot` pattern): vLLM boots, warms, and
`/sleep`s (level 1) inside `@modal.enter(snap=True)`, so the snapshot captures a
fully-initialized engine; restores just `/wake_up`. Reference numbers from
Modal: a 3B went ~118s → ~12s median cold start. Design points:

- **No `--enforce-eager`.** Compile + CUDA-graph cost is paid once at snapshot
  creation; eager mode costs ~3x decode throughput on a small model. (This also
  makes the persisted `/root/.cache/vllm` compile cache meaningful — under
  eager mode it was inert.) CUDA graphs are captured only at real batch sizes
  (`cudagraph_capture_sizes: [1,2,4,8]`, matching `max_inputs=8`). The cache is
  a deployment-specific, effectively immutable Volume; bump
  `VLLM_CACHE_VOLUME_NAME` when the model, vLLM, or compilation flags change.
  Do not clear it in place while a snapshot is live because Volume mutations
  do not invalidate Modal memory snapshots.
- **`min_containers=0`.** The service remains scale-to-zero; snapshots reduce
  restoration work without paying for an always-on L4.
- **`scaledown_window=600`.** The 60s default is chat-hostile — a visitor who
  pauses two minutes to read an answer eats a mid-conversation cold start.
  10 idle minutes on an L4 costs pennies at personal-site traffic.
- **First 2–3 cold boots after EVERY deploy are slow** — snapshots build over
  the first boots. Don't judge cold-start latency until ~boot 4.
- **L4 + GPU snapshots is unverified** (alpha feature, NVIDIA driver 570+ gate;
  Modal's examples use A10/H100). If snapshot creation fails on L4, flip
  `gpu="L4"` → `"A10"` (same 24GB class, snapshot-proven).
- **Wake-ahead:** the chat UI fires a fire-and-forget `POST /api/chat/wake` on
  mount; the Next.js route (server-side, so it can hold the proxy-auth headers)
  pings `<base>/models`, booting the container while the visitor types their
  first message. `@app.server` returns a retryable 503 while a container is
  restoring; if the visitor submits before it is ready, the chat route polls
  only that startup state with bounded backoff, sharing one 285-second budget
  between readiness and generation. No silent fallback to a gateway model —
  substituting a different model while ours warms would defeat the point of
  serving the fine-tune.

Endpoint is exposed with `@app.server` and its authenticated default
(`unauthenticated=False`): Modal's edge rejects unauthenticated requests before
a container starts, so random traffic never pays a GPU cold start. Proxy auth
is **not Bearer** — it requires `Modal-Key` / `Modal-Secret` HTTP headers
(create a proxy-auth token pair in the Modal dashboard under Settings → Proxy
Auth Tokens). The AI SDK reuses the existing `AMA_INFERENCE_BASE_URL` seam,
sending those headers via `AMA_INFERENCE_HEADERS`. Use the `.modal.direct` URL
printed by `modal deploy` and append `/v1`:

```
AMA_INFERENCE_BASE_URL = https://<deployed-app-server>.modal.direct/v1
AMA_DEPLOYMENT_MODEL   = ama
AMA_INFERENCE_HEADERS  = {"Modal-Key":"wk-…","Modal-Secret":"ws-…"}
```

(`AMA_INFERENCE_API_KEY` stays unset for Modal — it sends `Authorization:
Bearer`, which Modal proxy auth ignores; it remains the right variable for
Bearer-style endpoints like Tinker's OAI service or vLLM `--api-key`.)

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
   **Resolved 2026-08-02** with `deploy/chat_template_parity.jinja` (staged on
   the Volume, wired via `CUSTOM_CHAT_TEMPLATE`). The stock template diverged
   from training three ways: tools dumped OpenAI-wrapped
   (`{"type":"function","function":…}`) instead of bare; unicode left
   unescaped where training ascii-escaped (`json.dumps` defaults); and the
   blank-content separator before `<tool_call>` dropped in history turns.
   With the parity template, rendered strings are byte-identical to training.
   Sole irreducible residue: in assistant tool-call history turns the tinker
   renderer tokenizes chunk-wise (`\n\n`+`\n\n` = two tokens) while serving
   tokenizes the final string one-shot (one `\n\n\n\n` token) — behavioral
   effect measured at one synonym swap in one smoke answer (gate 4).
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
  `--language-model-only`, `--enable-sleep-mode`, `--compilation-config`).
  Parser names change between releases; `enable_thinking:false`+tools was
  broken pre-0.9 / vLLM #35574. The `/sleep`/`/wake_up` endpoints need
  `VLLM_SERVER_DEV_MODE=1` (set in the image).
- GPU memory snapshots are **alpha** (`experimental_options={"enable_gpu_snapshot": True}`)
  — the API namespace may change between modal releases, and per-GPU support
  is undocumented (driver 570+ gate).
- Qwen3.5 loads correctly in the pinned vLLM (hybrid linear-attention support is
  relatively recent — vLLM Qwen3-Next lineage).
- `@app.server` API and `nvidia/cuda:12.9.0` base in your installed `modal`
  version. Verify the emitted `.modal.direct` URL after each deployment.
- L4 per-second price; GPU memory snapshots (cold-start mitigation) are
  experimental — verify L4 support before enabling.
