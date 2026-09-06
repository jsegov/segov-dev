# Deployed-model AMA budget experiment — 2026-09-06 UTC

**Decision: no budget qualified; retain the existing 1,536-token default. The live quality gate remains failed.**

This experiment uses the configured OpenAI-compatible deployment and the updated runtime retrieval policy. It is separate from the earlier [GPT-5-mini experiment](budget-experiment-2026-09-06.md), which selected the current repository default. The endpoint and full source reports remain local; the checked-in comparison identity hashes bind the measured configuration without publishing its address. The serving alias was not independently bound to a checkpoint artifact, so this is budget-selection evidence, not checkpoint-promotion evidence.

## Method

All four caps (512, 1,024, 1,536, 2,400) were evaluated three times over the unchanged 150-case synthetic selection dataset: **1,800 subject cases**. Budgets were interleaved by repetition, with concurrency four. Production and tuning share model resolution, call settings, startup readiness, the SDK streaming agent, the public-response filter and browser transport. Only the output cap varied. AI SDK version: 6.0.238; temperature 0, seed 1, transport retries 0. Required judges used their recorded independent Gateway configuration.

The runtime now enforces one execution per context tool, requires public retrieval before resume retrieval, and supplies a current-step system reminder. Rejected repeat attempts remain visible in tool-order scoring. Work summaries must anonymize customer, account and partner identities. Retrieval fixtures, cases, scorers and quality thresholds were not relaxed. The separate frozen 32-case final suite was not used.

## Quality and decision

Each repetition must reach overall quality ≥85%, every category ≥75%, zero critical failures and complete required judge coverage. The selected cap must pass every repetition and be the smallest within one percentage point of the highest aggregate passing quality.

|   Cap | Mean quality | Passing repetitions | Cases with critical failures across 450 cases |
| ----: | -----------: | ------------------: | --------------------------------------------: |
|   512 |       97.51% |                 0/3 |                                             9 |
| 1,024 |       96.03% |                 0/3 |                                            23 |
| 1,536 |       95.42% |                 0/3 |                                            23 |
| 2,400 |       97.33% |                 0/3 |                                             9 |

Every cap failed the same three critical retrieval cases in its first two repetitions, before the later workstation interruption: `resume-education-schools` omitted resume retrieval after public content; `personal-orbit-notes-offline-recovery` and `personal-kiln-bench-architecture` attempted a repeated personal-context call. The SDK prevented repeated execution, but those attempts and their resulting fallback answers still fail the behavioral contract. Increasing the output cap did not resolve them.

|   Cap | Repetition | Quality | Cases with critical failures | Generation failures | Judge errors |
| ----: | ---------: | ------: | ---------------------------: | ------------------: | -----------: |
|   512 |          1 |  97.47% |                            3 |                   0 |            0 |
| 1,024 |          1 |  97.34% |                            3 |                   0 |            0 |
| 1,536 |          1 |  97.34% |                            3 |                   0 |            0 |
| 2,400 |          1 |  97.20% |                            3 |                   0 |            0 |
|   512 |          2 |  97.47% |                            3 |                   0 |            0 |
| 1,024 |          2 |  97.47% |                            3 |                   0 |            0 |
| 1,536 |          2 |  97.47% |                            3 |                   0 |            0 |
| 2,400 |          2 |  97.34% |                            3 |                   0 |            0 |
|   512 |          3 |  97.58% |                            3 |                   0 |            0 |
| 1,024 |          3 |  93.29% |                           17 |                  14 |            0 |
| 1,536 |          3 |  91.45% |                           17 |                  14 |            1 |
| 2,400 |          3 |  97.46% |                            3 |                   0 |            0 |

Counts below are failed critical checks, so one case can contribute to multiple rows.

| Failed critical check | Count |
| --------------------- | ----: |
| `judge_completion`    |     1 |
| `output_completion`   |    28 |
| `output_presence`     |    15 |
| `stream_integrity`    |    28 |
| `tool_order`          |    24 |
| `tool_usage`          |    12 |

| Category          | Mean quality across all runs |
| ----------------- | ---------------------------: |
| scope             |                      100.00% |
| conversation      |                       95.29% |
| public_content    |                       98.46% |
| resume            |                       88.72% |
| style             |                       95.72% |
| work_privacy      |                       96.98% |
| fallbacks         |                       97.76% |
| personal_projects |                       96.79% |

Required judges: **143/144 completed**, **1 errors**, **0 skipped**. Empty answers: **15**; truncated answers: **0**; public protocol failures: **28**; wire-privacy check failures: **0**. No failed or interrupted cases were removed, retried selectively, or treated as release evidence.

## Latency and usage, separate from quality

The third repetitions at 1,024 and 1,536 crossed workstation sleep/wake interruptions. Their saved durations include those pauses and are unsuitable as continuous-run latency measurements. They also contain explicit generation failures; the 1,536 run includes a judge error. These outcomes remain in the full decision and prevent passing evidence. The exact cause of each individual failed request was not separately established.

For a comparable timing view, the following table uses **the first two uninterrupted repetitions for every cap** (300 cases per cap). This subset is descriptive only and does not replace any quality-gate result. Latency covers startup/retrieval/generation and excludes judging; usage sums every model step and excludes judges. All saved per-run metrics, including interrupted runs, remain in the selection decision.

|   Cap | Mean total latency | Mean first-text latency | Mean input tokens | Mean output tokens |
| ----: | -----------------: | ----------------------: | ----------------: | -----------------: |
|   512 |              6.33s |                   3.69s |            3287.2 |              102.2 |
| 1,024 |              6.33s |                   3.70s |            3287.2 |              102.5 |
| 1,536 |              6.33s |                   3.69s |            3287.1 |              102.2 |
| 2,400 |              6.36s |                   3.68s |            3287.0 |              103.2 |

Recorded subject reasoning tokens across the matrix: **0**. These local fixture measurements do not establish production latency or checkpoint identity. No dollar-cost estimate was supplied.

## Evidence and next step

The [unaltered selection decision](deployed-budget-selection-2026-09-06.json) records all twelve source report IDs/hashes, configuration hashes, per-run metrics and the null selection. The full matrix and twelve immutable behavioral reports remain under the ignored `frontend/evals/ama/results/` directory; their hashes were checked against one another before this report was written. The full reports contain synthetic case outputs and the private endpoint configuration and are not included in this public report.

Matrix SHA-256: `440cbebafc1fe36c426603492cda15d3f67ae696cc8f19c5cede7b76ebb3d49c`. Selection-decision SHA-256: `9f53253a91c35785c2a59f55770c339307b916c6f86745591d1209ea884326b0`.

Retain 1,536 while investigating training/serving alignment and the retrieval behavior. Dynamic prompt/tool traces are intentionally excluded from the existing fixed-prefix training builders; see [training requirements](../../../../training/README.md). The current Qwen renderer/serving token mismatch also remains a release blocker. A targeted fine-tuning experiment requires compatible construction and explicitly approved synthetic data that excludes the evaluation suites. No model was trained, promoted or deployed by this experiment.

This experiment measured commit `c0eb066` with retrieval policy `single-use-context-v2`. Subsequent review fixes permit correction of rejected calls (`single-use-context-v3`); these results are historical evidence and do not attest to that changed runtime.
