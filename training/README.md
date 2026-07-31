# AMA Training Pipeline

Fine-tunes open-weight models on [Tinker](https://tinker-docs.thinkingmachines.ai/) to
behaviorally distill the AMA chatbot's teacher traces (see
`docs/ama-fine-tuning-experiment.md`). Built as a reusable foundation: adding a
future Tinker-supported model is a new preset, not a new pipeline.

## Layout

- `export/export-traces.mjs` — Neon `ama_traces` → training JSONL. Resolves
  per-turn trace rows into training conversations (branch resolution for
  regenerations, tool-result canonicalization, prefix-consistency stitching,
  truncated-turn exclusion) and emits both constructions plus
  `prompt-manifest.json` (the exact system prompt + tool declarations per
  content-hash version) and `export-report.json` (stats + sha256 hashes).
- `ama_training/manifest.py` — prompt manifest → system prompt + `ToolSpec`s.
- `ama_training/dataset.py` — `AmaTraceDatasetBuilder`: JSONL rows →
  cookbook `Message`/`ToolCall` objects, prepends the renderer's own
  `create_conversation_prefix_with_tools(...)` prefix per row.
- `ama_training/train.py` — presets + `tinker_cookbook.supervised.train` driver.
- `ama_training/validate.py` — offline pre-train gate (no API key).
- `ama_training/export_adapter.py` — trained checkpoint → PEFT LoRA adapter
  (or merged HF model) for serving; resolves the `sampler_weights` path.
- `deploy/modal_app.py` + `deploy/README.md` — Stage 2 Modal + vLLM serving of
  the fine-tune (base frozen, LoRA on top) with the render-gap-fixing flags.
- `data/` — gitignored; JSONL exports, reports, and exported adapters live here.
- `logs/` — gitignored; training run logs/checkpoint records.

## Setup

```bash
cd training
uv sync           # installs tinker, tinker-cookbook[inkling], torch
cp .env.example .env   # fill in TINKER_API_KEY / DATABASE_URL, then `source .env`
```

## Workflow

1. **Export traces** (needs the Neon `DATABASE_URL`):

   ```bash
   DATABASE_URL='postgresql://…' pnpm --filter ama-training export
   ```

   Writes `data/export/ama-traces-qwen.jsonl` (one example per turn),
   `data/export/ama-traces-inkling.jsonl` (one example per stitched
   conversation), the prompt manifest, and the report. Filter a different
   trace wave with `TRACE_ID_LIKE` / `TRACE_ID_NOT_LIKE`.

2. **Validate** (always run before training — fails if any example would have
   its targets truncated by `max_length`, or trains zero tokens):

   ```bash
   uv run python -m ama_training.validate preset=qwen3.5-4b limit=1440
   uv run python -m ama_training.validate preset=inkling-small limit=514
   ```

3. **Train**:

   ```bash
   TINKER_API_KEY=… uv run python -m ama_training.train preset=inkling-small
   TINKER_API_KEY=… uv run python -m ama_training.train preset=qwen3.5-4b
   ```

   Any `train.Config` field is overridable as `key=value`
   (e.g. `learning_rate=1e-4 num_epochs=1 wandb_project=ama`). The held-out
   split (`test_size=50`) auto-attaches an NLL evaluator; pick the checkpoint
   where held-out NLL bottoms out, never the last one by default.

4. **Tests**:

   ```bash
   uv run pytest
   ```

5. **Eval a checkpoint** against the frozen AMA suite via Tinker's
   OpenAI-compatible endpoint (run from the repo root; judge needs
   `AI_GATEWAY_API_KEY`):

   ```bash
   AMA_INFERENCE_BASE_URL='https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1' \
   AMA_INFERENCE_API_KEY="$TINKER_API_KEY" \
   AMA_DEPLOYMENT_MODEL='tinker://…/sampler_weights/final' \
   pnpm --filter frontend eval:ama
   ```

   The endpoint renders tool declarations with the model's default HF chat
   template, not this pipeline's train-time prefix, so scores measure the
   model as served — expect some tool-routing skew vs `ama_training.sample`.

6. **Export + serve (Stage 2)** — export the fine-tune and serve it on Modal +
   vLLM. For Qwen3.5-4B, export the **merged** model (a runtime LoRA adapter
   would be silently ignored on its fused linear-attention projections — see
   `deploy/README.md`):

   ```bash
   TINKER_API_KEY=… uv run python -m ama_training.export_adapter \
       preset=qwen3.5-4b merged=true output=data/adapters/qwen3.5-4b-merged
   ```

   See `deploy/README.md` for staging into a Modal Volume, `modal deploy`, the
   AI SDK wiring, and the deploy gates (merge integrity, no-thinking, render
   parity, behavioral parity, serving contract, full eval).

## Presets

| | `inkling-small` (Stage 1) | `qwen3.5-4b` (Stage 2) |
| --- | --- | --- |
| Model | `thinkingmachines/Inkling-Small` | `Qwen/Qwen3.5-4B` |
| Renderer | `tml_v0` | `qwen3_5_disable_thinking` |
| Export file | collapsed per conversation | per turn |
| Masking | `ALL_ASSISTANT_MESSAGES` | `LAST_ASSISTANT_TURN` |

The construction/masking pairing is load-bearing — see
"From per-turn traces to training conversations" in the design doc. Never
train per-turn rows with `ALL_ASSISTANT_MESSAGES` (prefixes double-train), and
`tml_v0` does not support `LAST_ASSISTANT_TURN` at all.

## Adding a future model

1. Check the renderer: `model_info.get_recommended_renderer_name(model)` and
   whether it has the extension property (`renderer.has_extension_property`).
   Extension property → collapsed export + `ALL_ASSISTANT_MESSAGES`; otherwise
   per-turn export + `LAST_ASSISTANT_TURN`.
2. Add a preset in `ama_training/train.py`.
3. Run `ama_training.validate` for the new preset; check the decoded trained
   region looks like the model's tool-call wire format.
4. Sweep LR before trusting another model family's optimum.

## Notes

- Training examples deliberately contain no system message; the prefix is
  rebuilt from `prompt-manifest.json` at dataset-build time so tool
  declarations land wherever the target renderer's serving template puts them
  (Qwen: inside the system message; TML: a `tool_declare` message).
- `tml_v0` injects a thinking-effort message into every rendered example
  (default 0.9, `AmaTraceDatasetBuilder.effort`). Serve-time
  `reasoning_effort` must match the training value.
- Loss masking is uniform: assistant prose and tool calls take loss; system,
  user, and tool-result tokens never do (weights come from the renderer via
  `TrainOnWhat`).
