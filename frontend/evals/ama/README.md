# AMA behavioral evaluations

The default evaluation follows the configured production model and call settings. It runs `ToolLoopAgent` through `createAgentUIStreamResponse`, applies the production public-stream filter, and consumes the result with `Chat` and `DefaultChatTransport`. Scorers inspect the answer that the browser receives. Server `onFinish` supplies ordered tool calls, completion reasons, usage, and the observed model identity; private tool payloads stay on that server branch.

Fixtures are synthetic and injected locally. These evaluations do not read production Blob, Edge Config, or trace data. Live subject and judge inference still requires model credentials and incurs provider charges. Unit tests use local SDK mocks.

## Profiles and partitions

| Profile                | Model and routing                              | Effective call settings                                  | Purpose                                                             |
| ---------------------- | ---------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| `production` (default) | `getAmaModelConfig()`                          | `getAmaCallSettings()`                                   | Measure the runtime configuration, including its output cap         |
| `tuning`               | Same runtime configuration                     | Same settings, with only the matrix output cap changed   | Compare output budgets on the selection partition                   |
| `benchmark`            | Allows `AMA_EVAL_MODEL` / `AMA_EVAL_PROVIDERS` | Historical 2400 cap, temperature 0, seed 1, maxRetries 1 | Historical comparison, explicitly distinct from production evidence |

`AMA_MAX_OUTPUT_TOKENS` is the shared positive-integer runtime cap; its default is **1536**, selected by the [three-repetition budget experiment](reports/budget-experiment-2026-09-06.md) for the locally configured `openai/gpt-5-mini`. Repeat the comparison for a different model or inference endpoint. `AMA_EVAL_MAX_OUTPUT_TOKENS` is benchmark-only. Production and tuning reject benchmark-only model, provider, and token overrides. Unspecified gateway sampling/retry settings retain SDK/provider defaults; the installed SDK version is recorded. Inference endpoints inherit the runtime's deterministic temperature/seed and retry configuration.

The **selection** partition retains the original 150 cases. The **final** partition is a separately authored frozen suite of 32 cases, four in each of the same eight categories, with different organizations, projects, education facts, and private canaries. Its fixtures and cases are frozen together in `final-release.json` under this canonical SHA-256:

```text
562666316ce39a665b07332e4aa11eb77892bdefde563afd453f3032e2a5717b
```

The final suite was frozen before budget comparison. Do not tune prompts, scorers, thresholds, fixtures, or budgets against final results. A changed final suite needs a separately reviewed version before the next selection run. `assertFrozenFinalSuite` rejects edits to the frozen content.

## Run commands

Run from `frontend/`, with credentials already loaded in the environment. Do not commit `.env` files.

```bash
# Exact configured runtime, selection partition, required judges
pnpm eval:ama:production

# Historical comparison profile
pnpm eval:ama:benchmark

# Four budgets × three repetitions; selection partition only
pnpm eval:ama:matrix

# Recompute the decision from a complete saved matrix, with no model calls
AMA_EVAL_MATRIX_REPORT=evals/ama/results/matrix-....json pnpm eval:ama:select

# Final release check after a successful budget decision
AMA_MAX_OUTPUT_TOKENS=1536 AMA_EVAL_SELECTION_REPORT=evals/ama/results/selection-....json pnpm eval:ama:final

# Offline fingerprints and policy for the training pipeline
pnpm eval:ama:export-manifest
```

The final example uses an illustrative budget: use the report's actual `selected_budget`. The runner verifies the selected budget, model configuration, prompt, scorer, transport, fixture, SDK, judge, and other call settings before making final model calls. The settings describe the environment running the command; they do not establish that an unrelated deployed site has identical environment variables.

Equivalent direct invocation is `pnpm exec vitest run --config vitest.eval.config.ts` with `AMA_EVAL_PROFILE=production|benchmark`, `AMA_EVAL_COMMAND=matrix|select|export-manifest`, or `AMA_EVAL_SUITE=final`. The standard suite may skip locally without credentials; matrix, final, and `AMA_EVAL_CI=1` fail when credentials are missing. `AMA_EVAL_CONCURRENCY` defaults to 4 and must be a positive integer.

## Budget decision and gates

The matrix tests **512, 1024, 1536, and 2400** tokens, three repetitions each. It interleaves budgets within repetitions. Every run uses the same configuration and selection cases; the comparison rejects incomplete matrices, duplicate repetitions, or differences beyond the output cap.

Each repetition must pass the existing quality thresholds: overall score at least 0.85, every category at least 0.75, and zero critical failures. Empty answers, truncated answers, protocol errors, private fields on the public stream, unfinished server generations, repeated retrieval, invalid retrieval order, and missing or failed required judge calls are critical. Required judge inference is independent of subject inference routing, uses the gateway model in `AMA_EVAL_JUDGE_MODEL` (default `openai/gpt-5-mini`), and optionally `AMA_EVAL_JUDGE_PROVIDERS`. A judge gets two bounded attempts; exhausted attempts remain explicit failed evidence. A completed judge's substantive grade contributes to quality. Production and tuning require every configured judge; disabling them cannot produce passing release evidence.

Of budgets passing **every repetition**, select the smallest whose average quality is within **0.01** of the highest average quality among passing budgets. The 2400 setting has no special baseline status. If none qualify, the report records no selection and the command fails after saving evidence; keep the existing runtime setting while investigating. The final suite remains a separate release gate after selection.

Tool diagnostics preserve call order, step numbers, and repeats; they do not combine the SDK's last-step calls with all-step calls. Resume retrieval must follow public content retrieval. Operational checks are hard gates and are excluded from the quality average, so extra successful infrastructure checks cannot inflate answer quality.

## Evidence and metrics

Every completed suite writes an immutable `selection-...json` or `final-...json` behavioral report, plus `latest.json` as a convenience pointer. The matrix also maintains a JSON file after each completed repetition/budget pair. An interrupted matrix retains completed evidence, but offline selection requires all 12 runs. A selection report includes each source report identity and hash.

Reports retain complete answers with private fixture canaries redacted, including canaries occurring in judge explanations and metadata. Console tables show shortened previews; the JSON keeps the full redacted answer. Provider response bodies, tool inputs, tool outputs, auth headers, and credentials are not written. Endpoint credentials and query strings are stripped from the serialized endpoint.

Metadata records the configured/observed model, provider when available, routing configuration, exact call settings, installed AI SDK version, judge configuration, repetition, timing, and hashes of the cases, fixtures, prompt/tools, prompt manifest, scorer, and public transport. Metrics include empty/truncated output counts, protocol/privacy/generation failures, required-judge errors/skips, subject input/output/reasoning tokens, mean/p95 generation latency, and mean time to the first nonblank public text token. Latency includes retrieval and the subject tool loop, and excludes judging.

`estimatedCostUsd` is null unless both `AMA_EVAL_INPUT_USD_PER_MILLION` and `AMA_EVAL_OUTPUT_USD_PER_MILLION` are explicitly supplied. When configured, this is an estimate for **subject inference only**, using reported token usage. It excludes judges, provider-specific caching discounts, and other fees. Missing provider usage fields contribute no tokens; inspect individual diagnostics before interpreting an estimate.

All artifact hashes use recursively key-sorted UTF-8 JSON, preserving array order. A behavioral report's `report_sha256` excludes only that field; a selection report's `selection_decision_sha256` excludes only that field. Hashes detect changed evidence and bind comparisons, but do not attest to a remotely served checkpoint by themselves.

## Training release evidence

The offline export creates `training-eval-manifest.json` and `release-policy.json` in `evals/ama/results/` (or `AMA_EVAL_MANIFEST_DIR`). It fingerprints both partitions, their case families, and normalized user questions, including scripted prior user turns. Question normalization is NFKC, lowercase, trim, and collapsed whitespace before canonical hashing. These fingerprints keep both suites out of training and validation data.

For candidate evidence, supply all bindings and run the production profile:

```bash
AMA_EVAL_REQUIRE_BINDINGS=1
AMA_EVAL_CANDIDATE_ID=...
AMA_EVAL_CHECKPOINT_PATH=...
AMA_EVAL_MODEL_ARTIFACT_SHA256=...
AMA_EVAL_SERVING_CONFIG_SHA256=...
```

These values must be exported in the shell or supplied together with the command. The final candidate run also needs `AMA_EVAL_SELECTION_DECISION_SHA256`, from the training pipeline's frozen selection decision. Presence and hash formats are validated before inference. The promotion gate must verify these bindings against actual checkpoint and serving manifests; the runner records the endpoint, configured model alias, observed model IDs, and effective settings for that comparison. Unbound local budget reports cannot stand in for candidate promotion evidence.

The behavioral envelope uses `schema_version: 1` and `report_type: ama_behavioral_eval`. Per-case evidence includes category, quality score, pass status, critical status, privacy status, and judge status. `counts.failed` counts case-level misses; `counts.completed` includes completed outcomes that failed a gate. Generation errors remain cases with failed critical checks. `judge_completed` includes substantive pass/fail judgments; `judge_errors` and `judge_skipped` identify incomplete judging. Aggregate quality and category thresholds permit noncritical case misses while requiring zero critical failures. The training promotion gate recomputes those conditions from the per-case evidence and pinned policy.

Bound final runs also require `AMA_EVAL_FINAL_ATTEMPT_ID`, the UUID claimed by the training registry before inference. The runner echoes it as `final_attempt_id`. The training orchestrator supplies `AMA_EVAL_OUTPUT_PATH` to write the behavioral envelope directly into that attempt's directory; the file is created exclusively and cannot overwrite an earlier attempt's evidence. Use the orchestrator's final-evaluation command so failed or interrupted attempts remain consumed and a second candidate cannot use the same final holdout.

## Verification and references

Run `pnpm exec vitest run tests/evals` for offline profile, scorer, matrix, hash, evidence, frozen-suite, and SDK transport regression tests. Full route-to-transport privacy tests live in `tests/lib/ama-chat-stream.integration.test.ts`.

The streaming boundary follows the documented [AI SDK UI stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol), including tool output events, and OWASP's guidance to [keep private data out of client responses](https://cheatsheetseries.owasp.org/cheatsheets/AJAX_Security_Cheat_Sheet.html#never-transmit-secrets-to-the-client). The production profile, separate selection/final data, explicit criteria, and repeated comparison follow [OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices). The local SDK source and regression tests establish this implementation's behavior; these references explain the associated engineering practices.
