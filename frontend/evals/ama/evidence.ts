import { randomUUID } from 'node:crypto'
import { sha256 } from './hashes'
import type { AmaEvalMetrics, AmaEvalSummary } from './types'

const BINDING_VARIABLES = {
  candidate_id: 'AMA_EVAL_CANDIDATE_ID',
  checkpoint_path: 'AMA_EVAL_CHECKPOINT_PATH',
  model_artifact_sha256: 'AMA_EVAL_MODEL_ARTIFACT_SHA256',
  serving_config_sha256: 'AMA_EVAL_SERVING_CONFIG_SHA256',
} as const

export function readEvidenceBindings(partition: 'selection' | 'final') {
  const required =
    process.env.AMA_EVAL_REQUIRE_BINDINGS === '1' ||
    Boolean(process.env.AMA_EVAL_CANDIDATE_ID?.trim())
  const bindings = Object.fromEntries(
    Object.entries(BINDING_VARIABLES).map(([key, variable]) => {
      const value = process.env[variable]?.trim() || null
      if (required && !value) {
        throw new Error(`${variable} is required for candidate evidence.`)
      }
      if (value && key.endsWith('_sha256') && !/^[a-f0-9]{64}$/.test(value)) {
        throw new Error(`${variable} must be a SHA-256 hash.`)
      }
      return [key, value]
    }),
  )
  const decision = process.env.AMA_EVAL_SELECTION_DECISION_SHA256?.trim() || null
  if (decision && !/^[a-f0-9]{64}$/.test(decision)) {
    throw new Error('AMA_EVAL_SELECTION_DECISION_SHA256 must be a SHA-256 hash.')
  }
  if (partition === 'final' && !decision && !process.env.AMA_EVAL_SELECTION_REPORT) {
    throw new Error(
      'Final evaluation requires a frozen selection decision (AMA_EVAL_SELECTION_REPORT or AMA_EVAL_SELECTION_DECISION_SHA256).',
    )
  }
  const attempt =
    partition === 'final' ? process.env.AMA_EVAL_FINAL_ATTEMPT_ID?.trim() || null : null
  if (partition === 'final' && required && !attempt) {
    throw new Error('AMA_EVAL_FINAL_ATTEMPT_ID is required for bound final evidence.')
  }
  if (attempt && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attempt)) {
    throw new Error('AMA_EVAL_FINAL_ATTEMPT_ID must be a UUID.')
  }
  return { ...bindings, selection_decision_sha256: decision, final_attempt_id: attempt }
}

function percentile95(values: number[]): number {
  if (!values.length) {
    return 0
  }
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!
}

function price(variable: string): number | null {
  const raw = process.env[variable]?.trim()
  if (!raw) {
    return null
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${variable} must be a nonnegative number.`)
  }
  return value
}

export function buildEvalMetrics(summary: AmaEvalSummary): AmaEvalMetrics {
  const results = summary.results
  const latencies = results.flatMap((result) =>
    typeof result.diagnostics?.latencyMs === 'number' ? [result.diagnostics.latencyMs] : [],
  )
  const firstTokens = results.flatMap((result) =>
    typeof result.diagnostics?.firstTextTokenMs === 'number'
      ? [result.diagnostics.firstTextTokenMs]
      : [],
  )
  const inputTokens = results.reduce(
    (total, result) => total + (result.diagnostics?.totalUsage?.inputTokens ?? 0),
    0,
  )
  const outputTokens = results.reduce(
    (total, result) => total + (result.diagnostics?.totalUsage?.outputTokens ?? 0),
    0,
  )
  const inputPrice = price('AMA_EVAL_INPUT_USD_PER_MILLION')
  const outputPrice = price('AMA_EVAL_OUTPUT_USD_PER_MILLION')
  return {
    emptyResponses: results.filter((result) => !result.output.trim()).length,
    truncatedResponses: results.filter((result) => result.diagnostics?.finishReason === 'length')
      .length,
    protocolFailures: results.filter((result) => result.diagnostics?.protocolPassed === false)
      .length,
    wirePrivacyFailures: results.filter((result) => result.diagnostics?.wirePrivacyPassed === false)
      .length,
    generationFailures: results.filter(
      (result) =>
        result.diagnostics?.errorKind || result.diagnostics?.serverFinishReceived === false,
    ).length,
    judgeErrors: results.filter((result) => result.judgeStatus === 'error').length,
    judgeSkipped: results.filter((result) => result.judgeStatus === 'skipped').length,
    inputTokens,
    outputTokens,
    reasoningTokens: results.reduce(
      (total, result) => total + (result.diagnostics?.totalUsage?.reasoningTokens ?? 0),
      0,
    ),
    meanLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
    p95LatencyMs: percentile95(latencies),
    meanFirstTextTokenMs: firstTokens.length
      ? firstTokens.reduce((a, b) => a + b, 0) / firstTokens.length
      : null,
    estimatedCostUsd:
      inputPrice === null || outputPrice === null
        ? null
        : (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000,
  }
}

export function buildBehavioralEvidence(
  summary: AmaEvalSummary,
  bindings: ReturnType<typeof readEvidenceBindings>,
) {
  const metadata = summary.metadata
  if (!metadata) {
    throw new Error('Behavioral evidence requires runner metadata.')
  }
  const results = summary.results.map((result) => ({
    case_id: result.id,
    category: result.category,
    critical_passed: result.criticalFailures.length === 0,
    passed: result.passed,
    score: result.weightedScore,
    critical_privacy_passed: result.scores
      .filter((score) =>
        ['forbidden_leakage', 'internal_tool_leakage', 'stream_integrity'].includes(score.name),
      )
      .every((score) => score.passed),
    judge_status: result.judgeStatus ?? 'not_required',
  }))
  const report = {
    schema_version: 1,
    report_type: 'ama_behavioral_eval',
    report_id: metadata.runId || randomUUID(),
    ...bindings,
    dataset_version: metadata.datasetSha256,
    dataset_sha256: metadata.datasetSha256,
    selection_dataset_sha256: metadata.selectionDatasetSha256,
    final_dataset_sha256: metadata.finalDatasetSha256,
    partition: metadata.partition,
    profile: metadata.profile,
    call_settings: metadata.callSettings,
    model: summary.modelConfig.model,
    inference_base_url: summary.modelConfig.inference?.baseURL ?? null,
    observed_models: [
      ...new Set(
        summary.results.flatMap((result) =>
          result.diagnostics?.responseModel ? [result.diagnostics.responseModel] : [],
        ),
      ),
    ],
    model_config_sha256: metadata.modelConfigSha256,
    started_at: metadata.startedAt,
    completed_at: metadata.completedAt,
    counts: {
      expected: summary.totalCases,
      completed: results.length,
      failed: results.filter((result) => !result.passed).length,
      judge_expected: results.filter((result) => result.judge_status !== 'not_required').length,
      judge_completed: results.filter(
        (result) => result.judge_status === 'passed' || result.judge_status === 'failed',
      ).length,
      judge_skipped: results.filter((result) => result.judge_status === 'skipped').length,
      judge_errors: results.filter((result) => result.judge_status === 'error').length,
    },
    passed: summary.passed,
    results,
    summary,
  }
  return { ...report, report_sha256: sha256(report) }
}
