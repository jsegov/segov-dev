# AMA output-budget experiment — 2026-09-06 UTC

**Decision: set the repository default to 1,536 output tokens per model step.**

This tests the locally configured `openai/gpt-5-mini` through AI Gateway. No local model or inference-endpoint override was configured. Vercel production environment values could not be inspected, so this report does not attest to an independently deployed environment. No deployment was performed.

## Method

Four budgets (512, 1,024, 1,536, 2,400), three repetitions of all 150 selection cases: **1,800 subject cases**. Budgets were interleaved by repetition with concurrency four. The `tuning` profile used the production model resolver, `getAmaCallSettings`, `ToolLoopAgent`, real streaming response, public-response filter, and browser transport. Only the output cap varied. Retrieval was synthetic; production Blob, Edge Config and trace data were not accessed.

AI SDK `6.0.238`; observed model IDs: `gpt-5-mini-2025-08-07`. Gateway routing used its configured automatic behavior. Observed routing provider: unavailable in the recorded SDK metadata. Temperature, seed and subject retry settings inherited the same SDK/provider defaults in every run. The cap includes reasoning tokens and applies per model step, so total usage across a tool loop can exceed it.

Each repetition must meet overall quality ≥85%, every category ≥75%, and zero critical failures, including empty/truncated answers and protocol/privacy failures. Required judges must complete. Among budgets passing every repetition, choose the smallest within one percentage point of the best aggregate passing quality. Latency and usage do not enter the quality score. This implements the agreed rule and [representative, reproducible evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices).

## Quality and eligibility

|   Cap | Mean quality | Passing repetitions | Cases with critical failures | Empty answers | Truncated answers |
| ----: | -----------: | ------------------: | ---------------------------: | ------------: | ----------------: |
|   512 |       58.39% |                 0/3 |                          239 |           181 |               235 |
| 1,024 |       94.17% |                 0/3 |                           29 |            10 |                28 |
| 1,536 |       96.33% |                 3/3 |                            0 |             0 |                 0 |
| 2,400 |       96.06% |                 2/3 |                            1 |             0 |                 0 |

Counts cover 450 cases per budget. Empty and truncated counts can overlap.

|   Cap | Critical check failures across all repetitions                                            |
| ----: | ----------------------------------------------------------------------------------------- |
|   512 | `exact_match`: 1, `output_completion`: 239, `output_presence`: 181, `stream_integrity`: 7 |
| 1,024 | `forbidden_leakage`: 1, `output_completion`: 28, `output_presence`: 10                    |
| 1,536 | None                                                                                      |
| 2,400 | `forbidden_leakage`: 1                                                                    |

`output_presence` identifies empty answers. `output_completion` requires server completion with finish reason `stop` and no error; the truncated-answer column counts only `length` finishes. `stream_integrity` rejects failed public protocol or privacy checks. `forbidden_leakage` is an answer-text disclosure failure, distinct from raw retrieval data appearing in public stream events. `exact_match` is a required literal-answer failure. The archived evidence identifies the affected cases without retaining private canaries.

Public-stream privacy failures: **0**. Required judge outcomes: **144 completed**, **0 errors**, **0 skipped**. A substantive failed judge grade is completed evidence and contributes to quality.

## Latency and subject token usage

|   Cap | Mean total latency | Mean first-text latency (observed cases) | Mean input tokens | Mean output tokens | Mean reasoning tokens |
| ----: | -----------------: | ---------------------------------------: | ----------------: | -----------------: | --------------------: |
|   512 |              6.95s |                          5.21s (269/450) |           2,729.0 |              643.1 |                 499.1 |
| 1,024 |              8.03s |                          7.03s (440/450) |           2,794.1 |              797.6 |                 578.7 |
| 1,536 |              7.87s |                          6.99s (450/450) |           2,768.2 |              807.5 |                 581.4 |
| 2,400 |              7.76s |                          6.89s (450/450) |           2,767.2 |              803.0 |                 576.7 |

Latency includes the subject tool loop and excludes judging. First-text latency includes only cases that emitted nonblank public text; empty responses have no such measurement. Token averages sum all model steps and exclude judge usage. Background repository checks ran during parts of the experiment, so latency is descriptive rather than a controlled performance benchmark. These are local fixture measurements, not production network or cold-start benchmarks; three repetitions do not establish a formal confidence interval.

## Repetition results

|   Cap | Repetition | Quality | Gate | Empty | Truncated | Protocol failures | Incomplete judges |
| ----: | ---------: | ------: | :--- | ----: | --------: | ----------------: | ----------------: |
|   512 |          1 |  58.74% | Fail |    60 |        78 |                 2 |                 0 |
|   512 |          2 |  57.61% | Fail |    62 |        80 |                 1 |                 0 |
|   512 |          3 |  58.81% | Fail |    59 |        77 |                 4 |                 0 |
| 1,024 |          1 |  94.44% | Fail |     3 |         8 |                 0 |                 0 |
| 1,024 |          2 |  94.53% | Fail |     2 |        11 |                 0 |                 0 |
| 1,024 |          3 |  93.53% | Fail |     5 |         9 |                 0 |                 0 |
| 1,536 |          1 |  96.82% | Pass |     0 |         0 |                 0 |                 0 |
| 1,536 |          2 |  96.25% | Pass |     0 |         0 |                 0 |                 0 |
| 1,536 |          3 |  95.92% | Pass |     0 |         0 |                 0 |                 0 |
| 2,400 |          1 |  96.32% | Pass |     0 |         0 |                 0 |                 0 |
| 2,400 |          2 |  95.78% | Fail |     0 |         0 |                 0 |                 0 |
| 2,400 |          3 |  96.08% | Pass |     0 |         0 |                 0 |                 0 |

## Reproduction and evidence

- [Selection decision](budget-selection-2026-09-06.json) records the rule, comparison configuration, per-run report IDs/hashes and metrics.
- [Complete redacted matrix](budget-matrix-2026-09-06.json.gz) retains per-case scores, categories, finish reasons, ordered tool calls, usage, timing and provenance hashes for all 12 runs. It contains synthetic evaluation content, not production traces or credentials.
- [Evaluation operations](../README.md) documents live reruns and offline selection. To recheck selection without model calls, decompress the archive and supply its absolute path as `AMA_EVAL_MATRIX_REPORT` to `pnpm --filter frontend eval:ama:select`.

Matrix SHA-256: `7d91151c1ee2e732cb2e841fbdfda02e58f8b30cf14b1524136c580cb63574de`. Selection-decision SHA-256: `42cdb0b08718e0f34c2e9175f751b2fd27b50575a02eb4ce299f7c3ffa646d10`.

The separate 32-case synthetic final suite was frozen before tuning and was not used for this budget decision. Its SHA-256 is `562666316ce39a665b07332e4aa11eb77892bdefde563afd453f3032e2a5717b`. Checkpoint promotion additionally requires locked-winner final evaluation and matching serving/artifact evidence. No checkpoint was promoted in this experiment.
