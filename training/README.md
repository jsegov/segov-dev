# AMA training and release workflow

This is a local CLI pipeline for behavioral distillation of the AMA agent. It acquires a synthetic trace snapshot, builds reviewed data offline, groups related conversations into persisted partitions, validates the actual training configuration, and records checkpoint candidates. A deployable pointer is updated automatically only after evidence passes release gates. Promotion never deploys a model.

Masking user/tool-result loss does **not** prevent memorization: assistant targets can contain facts, and tool results remain conditioning context. Review the complete input and output, including retrieved context. Visitor conversations are excluded. Private or inappropriate synthetic traces must be rejected or sanitized before a new snapshot is approved; editing a reviewed row invalidates its approval hash.

## Setup and offline tests

```bash
pnpm install
uv sync --project training --frozen --group dev
cd training
node --test export/*.test.mjs
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 uv run --no-sync python -m pytest -q
```

Tests use synthetic fixtures and the real cached Qwen/TML tokenizers, and include the Modal SDK. Public tokenizers must be downloaded once before offline tests; CI does this in a separate step. Tests do not call Tinker or deploy anything. Keep all artifacts under ignored `training/data/` or `training/logs/`; never commit `.env` files or trace contents.

## 1. Acquire a versioned snapshot, then review

Acquisition is the only database step. Run it explicitly with the existing database credentials:

```bash
pnpm --filter ama-training export snapshot --out data/snapshots/wave-1
```

The script defaults to conversation IDs matching `synth-%`; `TRACE_ID_LIKE` and `TRACE_ID_NOT_LIKE` narrow acquisition. Prefixes are an acquisition filter, not approval. The snapshot stores raw trace rows, captured prompt/tool declarations, immutable file hashes, and review/policy templates. Output directories must be new.

Generate the frozen evaluation fingerprint manifest and release policy **offline**, from the frontend workspace:

```bash
AMA_EVAL_COMMAND=export-manifest pnpm --filter frontend exec vitest run --config vitest.eval.config.ts
```

Copy the snapshot's `policy.template.json` and `review-manifest.template.json` to versioned policy/review files. The policy requires explicit `allowed_models`, `allowed_response_models`, `allowed_prompt_versions`, synthetic conversation prefixes, and `evaluation_fingerprints_sha256` (the canonical SHA-256 of the generated `training-eval-manifest.json` object).

For each approved trace, preserve `row_sha256`, set `decision: "approved"`, keep `corpus_class: "synthetic"`, assign a stable `family_id` shared by all paraphrases/regenerations of one synthetic scenario, and write a review `reason`. Leave rejected or unreviewed rows out of training. Family IDs and normalized questions from both selection and final evaluation suites are excluded. Exact fingerprint checks do not replace review for semantic near-duplicates.

## 2. Build offline and persist grouped partitions

```bash
pnpm --filter ama-training export build \
  --snapshot data/snapshots/wave-1 \
  --policy data/reviews/wave-1-policy.json \
  --reviews data/reviews/wave-1-reviews.json \
  --fingerprints ../frontend/evals/ama/results/training-eval-manifest.json \
  --out data/export
cd training
uv run --no-sync python -m ama_training.split \
  --dataset data/export/dataset-manifest.json --out data/export/split-manifest.json
```

Paths supplied to the package script resolve from `training/`. Build performs no network work. It reports separate exclusion counts for pending, rejected, changed, superseded, wrong-model, wrong-prompt, unfinished, visitor, and evaluation-overlapping rows. Changed approval hashes exclude those rows; a changed sealed snapshot still aborts the build. Regeneration resolution runs against the complete snapshot before eligibility filtering. Qwen uses approved per-turn histories. Inkling requires contiguous, identical-prefix histories with one prompt version and approval for every selected turn; pruned histories remain per-turn only.

`dataset-manifest.json` binds outputs, original source snapshot, policy, reviews, fingerprints and exclusions. Python verifies those files and the approval lineage before rendering. Changes require a new snapshot/build, not editing a manifest to silence validation.

Partitions are approximately 80/10/10 by independent conversation/family group, seed 0, with at least ten groups and a nonempty selection/final partition. Every turn in a conversation and every reviewed family stays together. For a new dataset version, **always pass `--previous previous/split-manifest.json`** and write a new split file. Existing identities retain their partitions, including families absent in an intermediate snapshot. A new family bridge across frozen partitions fails instead of moving data.

## 3. Validate and train the same configuration

```bash
uv run --no-sync python -m ama_training.validate \
  preset=qwen3.5-4b warm_start=false output=data/preflight.json \
  dataset_builder.common_config.max_length=32768

# Explicit paid training, only when ready:
uv run --no-sync python -m ama_training.train \
  preset=qwen3.5-4b warm_start=false log_path=logs/wave-1 \
  dataset_builder.common_config.max_length=32768
```

`validate` and `train` resolve the same `key=value` overrides; nested builder overrides work. Training runs preflight automatically before creating a service client. All rows receive schema/provenance checks; every train/selection row is rendered with the actual renderer, masking, effort, maximum length and next-token-shifted datum. Any truncation, empty partition, or missing/invalid positive training targets fails. Final targets are not rendered, decoded, or summarized until one winner is locked. The optional `limit=0..100` on `validate` prints bounded metadata-only previews of train/selection examples after the complete preflight passes. Its default is zero. It never reduces validation coverage, changes preflight identity, prints raw text, or previews final targets.

The preflight hashes the resolved configuration, input manifests, pipeline source, lockfile and installed dependency versions. Each run keeps `preflight.json` and `run-manifest.json`. Existing logs may resume only with matching provenance. A warm start from another run loads weights with a fresh optimizer; resuming the same cookbook log restores training state. `latest_training_state` is for this progress/resume behavior only. A warm start must resolve to a verified registered candidate with an unbroken parent chain, matching evaluation exclusions, and preserved conversation/family partitions. Legacy or unregistered weights require a fresh base run (`warm_start=false`); changing the frozen evaluation suites also requires fresh base weights unless all ancestry has already been verified against those same suites.

Presets remain coupled to construction/masking:

| Preset          | Renderer                   | Construction          | Loss                   |
| --------------- | -------------------------- | --------------------- | ---------------------- |
| `qwen3.5-4b`    | `qwen3_5_disable_thinking` | per turn              | last assistant turn    |
| `inkling-small` | `tml_v0`                   | stitched conversation | all assistant messages |

Final and periodic checkpoints with both actual state and sampler paths become registry candidates. Missing sampler paths are never guessed. Candidate identity binds checkpoint, training config, dataset/split, preflight, prompt versions and expected partition sizes.

## 4. Produce candidate evidence explicitly

Inspect `data/checkpoints.json` for candidate IDs. Use the exact original training overrides for `score` and `sample`, including the original warm-start setting; changed code/data/dependencies/configuration is rejected.

```bash
uv run --no-sync python -m ama_training.score \
  candidate=CANDIDATE_ID output=data/evidence/nll.json preset=qwen3.5-4b warm_start=false
uv run --no-sync python -m ama_training.sample \
  candidate=CANDIDATE_ID prompt_version=all output=data/evidence/smoke.json preset=qwen3.5-4b warm_start=false
uv run --no-sync python -m ama_training.export_adapter \
  candidate=CANDIDATE_ID preset=qwen3.5-4b output=data/models/CANDIDATE_ID
```

These commands explicitly call Tinker. NLL scores the complete selection partition. Smoke runs tool-specific counterfactual fixtures, refusal and greeting checks for **every captured prompt version** using the training renderer and effort. When the prompt manifest contains multiple versions, `sample` requires explicit `prompt_version=all` or `prompt_version=<captured-version>`. A single-version diagnostic cannot satisfy promotion coverage for a multi-version candidate. Smoke reports keep response hashes, not raw private text.

Qwen export defaults to a merged HF model because its recurrent projection layout needs full delta fidelity. `checkpoint=` is permitted for explicit exploratory exports, but candidate-bound evidence is required for release. The exporter never chooses the latest state. Every model file is hashed in `artifact-manifest.json`; output is immutable. `merged=false` is exploratory and cannot pass this Qwen serving gate.

Serve the explicit artifact in a staging endpoint using [deployment instructions](deploy/README.md). Boot verifies all model files and advertises immutable artifact/server aliases. Run `ama_training.verify_serving` with the artifact directory, checked template and production runtime settings; it verifies template token parity, readiness, identity and real streamed tool use, and writes a sealed report. This probe calls the staging endpoint and does not deploy it.

Run the frontend production selection suite against that verified artifact alias. Set `AMA_EVAL_REQUIRE_BINDINGS=1` and bind `AMA_EVAL_CANDIDATE_ID`, `AMA_EVAL_CHECKPOINT_PATH`, `AMA_EVAL_MODEL_ARTIFACT_SHA256`, and `AMA_EVAL_SERVING_CONFIG_SHA256` to the matching reports. Selection/final behavior must use the same endpoint, observed artifact alias and exact inference settings as serving verification. Required judges must run. No environment boolean can substitute for measured gate evidence.

## 5. Lock the winner, evaluate final once, and promote automatically

Create a bundle JSON array with one object per candidate:

```json
[
  {
    "candidate_id": "...",
    "artifact": "data/models/.../artifact-manifest.json",
    "nll": "data/evidence/nll.json",
    "smoke": "data/evidence/smoke.json",
    "serving": "data/evidence/serving.json",
    "selection": "../frontend/evals/ama/results/selection-evidence.json"
  }
]
```

The frontend runner writes the behavioral envelope as its evidence artifact; use that path, not a legacy summary-only JSON file. Then:

```bash
uv run --no-sync python -m ama_training.release select \
  --policy ../frontend/evals/ama/results/release-policy.json \
  --bundle data/evidence/bundle.json --out data/evidence/decision.json
```

Passing candidates must have complete bound NLL, renderer smoke, verified serving and behavioral evidence. Gates recompute results against exact policy case/category/judge identities: overall score >= 0.85, each category >= 0.75, no critical failures, no missing cases or skipped/error judges. Candidates must share preset, corpus and split. Ranking is selection behavioral score descending, NLL ascending, earlier training step, then checkpoint/candidate identity. The winner and all evidence hashes are locked before final evaluation.

Save the exact original training override arguments as a JSON array, for example `["preset=qwen3.5-4b", "warm_start=false"]`. Then explicitly start the paid final evaluation:

```bash
uv run --no-sync python -m ama_training.release evaluate-final \
  --decision data/evidence/decision.json --training-args data/evidence/training-args.json \
  --out data/evidence/final-attempt
```

This command claims a unique final attempt in the registry **before any model calls**, invokes the frozen production frontend suite and locked-winner final NLL, verifies both attempt-bound reports, and automatically promotes if they pass. It supplies the exact verified endpoint, artifact alias and inference settings. Existing endpoint/judge credentials are used but never written to evidence. A failure or interruption consumes the attempt; even an incomplete attempt cannot be retried or replaced by a runner-up. Output directories must be new. The lower-level `promote --decision ... --final ... --final-nll ...` only accepts reports from an already claimed attempt.

Final NLL is a finite diagnostic, not an arbitrary quality threshold. Final behavioral checks use the frozen gate policy. Passing checks automatically update `deployable` and preserve rollback history. Any final failure records a stop and preserves the previous pointer; the same frozen final dataset cannot select a runner-up or another winner. Remediation uses development/selection data and a separately versioned final suite. Promotion does not deploy or change production environment variables.

```bash
uv run --no-sync python -m ama_training.release rollback --preset qwen3.5-4b
```

Rollback restores the previous deployable pointer and records history; deploying that artifact is still a separate operator action.

The design follows [Tinker renderer/masking contracts](https://tinker-docs.thinkingmachines.ai/tutorials/core-concepts/rendering/), [grouped validation](https://scikit-learn.org/stable/modules/cross_validation.html#cross-validation-iterators-for-grouped-data), [HF chat-template fidelity](https://huggingface.co/docs/transformers/main/en/chat_templating_writing), and [Modal snapshot lifecycle](https://modal.com/docs/guide/memory-snapshots). Cross-language evidence uses [RFC 8785 canonical JSON](https://www.rfc-editor.org/rfc/rfc8785), including ECMAScript number formatting and Unicode key order. Hashes are reproducibility checks, not cryptographic approval signatures; review files and gate policy remain trusted local inputs.
