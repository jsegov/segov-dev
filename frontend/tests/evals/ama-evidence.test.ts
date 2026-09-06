import { afterEach, describe, expect, it, vi } from 'vitest'
import { amaEvalDataset } from '@/evals/ama/dataset'
import {
  buildBehavioralEvidence,
  buildEvalMetrics,
  readEvidenceBindings,
} from '@/evals/ama/evidence'
import { canonicalJson, sha256 } from '@/evals/ama/hashes'
import {
  AMA_BUDGETS,
  buildBudgetSelectionReport,
  validateSelectionReport,
  type MatrixRun,
} from '@/evals/ama/matrix'
import {
  assertFrozenFinalSuite,
  finalReleaseDataset,
  FINAL_RELEASE_DATASET_SHA256,
  getFinalFixtureDependencies,
} from '@/evals/ama/release'
import { SELECTION_DATASET_SHA256 } from '@/evals/ama/run'
import { buildAmaEvalSummary } from '@/evals/ama/scorers'
import { buildTrainingEvalManifests } from '@/evals/ama/training-manifest'
import type { AmaEvalSummary } from '@/evals/ama/types'

afterEach(() => vi.unstubAllEnvs())

function suite(budget: number, repetition: number, quality: number): AmaEvalSummary {
  const summary = buildAmaEvalSummary({
    modelConfig: { model: 'openai/test' },
    results: amaEvalDataset.map((item) => ({
      id: item.id,
      category: item.category,
      prompt: item.prompt,
      output: 'I build tools.',
      redactedOutput: 'I build tools.',
      toolCalls: [],
      scores: [{ name: 'stream_integrity', passed: true, score: 1, critical: true, details: 'OK' }],
      weightedScore: quality,
      passed: true,
      criticalFailures: [],
      judgeStatus: item.judge ? 'passed' : 'not_required',
      diagnostics: {
        stepCount: 1,
        stepFinishReasons: ['stop'],
        finishReason: 'stop',
        protocolPassed: true,
        wirePrivacyPassed: true,
        serverFinishReceived: true,
        latencyMs: 10,
        firstTextTokenMs: 2,
        totalUsage: { inputTokens: 10, outputTokens: 2, reasoningTokens: 1 },
      },
    })),
  })
  summary.metadata = {
    runId: `${budget}-${repetition}`,
    profile: 'tuning',
    partition: 'selection',
    datasetSha256: SELECTION_DATASET_SHA256,
    selectionDatasetSha256: SELECTION_DATASET_SHA256,
    finalDatasetSha256: FINAL_RELEASE_DATASET_SHA256,
    fixtureSha256: 'fixtures',
    scorerSha256: 'scorers',
    transportSha256: 'transport',
    promptSha256: 'prompt',
    promptManifestSha256: `manifest-${budget}`,
    modelConfigSha256: 'model',
    callSettings: { maxOutputTokens: budget },
    sdkVersion: '6.test',
    judgeModel: 'openai/judge',
    judgeModelConfig: { model: 'openai/judge' },
    judgeCallSettings: {
      temperature: 0,
      maxRetries: 0,
      timeout: { totalMs: 120_000 },
      attempts: 2,
    },
    judgeRequired: true,
    repetition,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
  }
  summary.metrics = buildEvalMetrics(summary)
  return summary
}

function matrix(qualities = [0.93, 0.942, 0.95, 0.955]): MatrixRun[] {
  return AMA_BUDGETS.flatMap((budget, index) =>
    [1, 2, 3].map((repetition) => ({
      budget,
      repetition,
      report_id: `${budget}-${repetition}`,
      report_sha256: 'a'.repeat(64),
      summary: suite(budget, repetition, qualities[index]!),
    })),
  )
}

describe('budget selection evidence', () => {
  it('selects the smallest budget within one percentage point of the best passing quality', () => {
    const report = buildBudgetSelectionReport(matrix())
    expect(report.selected_budget).toBe(1536)
    expect(validateSelectionReport(report)).toEqual(report)
    // The highest quality may occur below 2400, and 512 is eligible when close enough.
    expect(buildBudgetSelectionReport(matrix([0.951, 0.96, 0.952, 0.95])).selected_budget).toBe(512)
  })

  it('rejects a budget when one repetition has an operational failure, regardless of quality', () => {
    const runs = matrix([0.97, 0.95, 0.94, 0.94])
    runs[0]!.summary.results[0]!.diagnostics!.wirePrivacyPassed = false
    expect(buildBudgetSelectionReport(runs).selected_budget).toBe(1024)
  })

  it('records no selection when every budget fails a repetition', () => {
    const runs = matrix()
    for (const budget of AMA_BUDGETS) {
      runs.find((run) => run.budget === budget)!.summary.metrics!.judgeErrors = 1
    }
    const report = buildBudgetSelectionReport(runs)
    expect(report.selected_budget).toBeNull()
    expect(report.passed).toBe(false)
    expect(() => validateSelectionReport(report)).toThrow('no passing budget')
  })

  it('rejects incomplete, duplicate, and differently configured matrices', () => {
    expect(() => buildBudgetSelectionReport(matrix().slice(1))).toThrow('complete')
    const duplicates = matrix()
    duplicates[1] = duplicates[0]!
    expect(() => buildBudgetSelectionReport(duplicates)).toThrow('duplicate')
    const changed = matrix()
    changed[0]!.summary.metadata!.callSettings.temperature = 0
    expect(() => buildBudgetSelectionReport(changed)).toThrow('Only maxOutputTokens')
    const missingCase = matrix()
    missingCase[0]!.summary.results.pop()
    expect(() => buildBudgetSelectionReport(missingCase)).toThrow('incomplete')
  })

  it('rejects a changed selection report', () => {
    const report = buildBudgetSelectionReport(matrix())
    report.selected_budget = 512
    expect(() => validateSelectionReport(report)).toThrow('changed')
  })

  it.each([
    { temperature: 0.5 },
    { maxRetries: 1 },
    { timeout: { totalMs: 60_000 } },
    { attempts: 1 },
  ])('rejects a changed judge call setting: %o', (changedSettings) => {
    const runs = matrix()
    const metadata = runs[0]!.summary.metadata!
    metadata.judgeCallSettings = { ...metadata.judgeCallSettings, ...changedSettings }
    expect(() => buildBudgetSelectionReport(runs)).toThrow('Only maxOutputTokens')
  })
})

describe('release suite and promotion evidence', () => {
  it('pins a separate 32-case final suite covering all eight categories', async () => {
    expect(assertFrozenFinalSuite).not.toThrow()
    expect(finalReleaseDataset).toHaveLength(32)
    expect(new Set(finalReleaseDataset.map((item) => item.category)).size).toBe(8)
    for (const item of finalReleaseDataset) {
      expect(
        amaEvalDataset.some(
          (selection) => selection.id === item.id || selection.prompt === item.prompt,
        ),
      ).toBe(false)
    }
    const fixture = await getFinalFixtureDependencies('default').getPublicSiteContent!()
    expect(fixture.projects.every((project) => typeof project.githubUrl === 'string')).toBe(true)
  })

  it('binds all results and counts into canonical evidence and records observed settings', () => {
    const summary = suite(512, 1, 0.95)
    summary.results[0]!.judgeStatus = 'error'
    summary.results[1]!.judgeStatus = 'skipped'
    const evidence = buildBehavioralEvidence(summary, {
      candidate_id: null,
      checkpoint_path: null,
      model_artifact_sha256: null,
      serving_config_sha256: null,
      selection_decision_sha256: null,
      final_attempt_id: null,
    })
    const { report_sha256, ...payload } = evidence
    expect(sha256(payload)).toBe(report_sha256)
    expect(evidence.call_settings).toEqual({ maxOutputTokens: 512 })
    expect(evidence.counts).toMatchObject({
      expected: 150,
      completed: 150,
      judge_errors: 1,
      judge_skipped: 1,
    })
    expect(evidence.results[0]).toMatchObject({
      category: amaEvalDataset[0]!.category,
      critical_passed: true,
      judge_status: 'error',
    })
    expect(canonicalJson({ z: 1, a: { b: 2, a: 'é' } })).toBe('{"a":{"a":"é","b":2},"z":1}')
  })

  it('fails incomplete candidate bindings and requires a frozen final decision', () => {
    vi.stubEnv('AMA_EVAL_REQUIRE_BINDINGS', '1')
    vi.stubEnv('AMA_EVAL_CANDIDATE_ID', '')
    expect(() => readEvidenceBindings('selection')).toThrow('CANDIDATE_ID')
    vi.stubEnv('AMA_EVAL_REQUIRE_BINDINGS', '')
    vi.stubEnv('AMA_EVAL_SELECTION_DECISION_SHA256', '')
    vi.stubEnv('AMA_EVAL_SELECTION_REPORT', '')
    expect(() => readEvidenceBindings('final')).toThrow('frozen selection')
  })

  it('requires and records the registry attempt UUID for bound final evidence', () => {
    vi.stubEnv('AMA_EVAL_REQUIRE_BINDINGS', '1')
    vi.stubEnv('AMA_EVAL_CANDIDATE_ID', 'candidate')
    vi.stubEnv('AMA_EVAL_CHECKPOINT_PATH', 'tinker://candidate')
    vi.stubEnv('AMA_EVAL_MODEL_ARTIFACT_SHA256', 'a'.repeat(64))
    vi.stubEnv('AMA_EVAL_SERVING_CONFIG_SHA256', 'b'.repeat(64))
    vi.stubEnv('AMA_EVAL_SELECTION_DECISION_SHA256', 'c'.repeat(64))
    vi.stubEnv('AMA_EVAL_CHECKPOINT_DECISION', '/frozen/decision.json')
    vi.stubEnv('AMA_EVAL_FINAL_ATTEMPT_ID', '')
    expect(() => readEvidenceBindings('final')).toThrow('FINAL_ATTEMPT_ID')
    const attempt = '12345678-1234-1234-1234-123456789abc'
    vi.stubEnv('AMA_EVAL_FINAL_ATTEMPT_ID', attempt)
    const summary = suite(512, 1, 0.95)
    summary.metadata!.partition = 'final'
    expect(buildBehavioralEvidence(summary, readEvidenceBindings('final')).final_attempt_id).toBe(
      attempt,
    )
  })

  it('exports fingerprints for both suites and prior user turns without model calls', () => {
    const { manifest, policy } = buildTrainingEvalManifests()
    expect(manifest.family_ids).toHaveLength(182)
    expect(manifest.question_sha256).toContain(
      sha256(amaEvalDataset[0]!.prompt.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()),
    )
    expect(policy.final_dataset_sha256).toBe(FINAL_RELEASE_DATASET_SHA256)
    const { artifact_sha256, ...payload } = policy
    expect(sha256(payload)).toBe(artifact_sha256)
  })
})
