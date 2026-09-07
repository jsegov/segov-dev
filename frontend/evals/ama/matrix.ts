import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { amaEvalDataset } from './dataset'
import { buildBehavioralEvidence, readEvidenceBindings } from './evidence'
import { sha256 } from './hashes'
import { assertFrozenFinalSuite, FINAL_RELEASE_DATASET_SHA256 } from './release'
import { getRedactedSummary, RESULTS_DIR, runAmaEvalSuite, SELECTION_DATASET_SHA256 } from './run'
import type { AmaEvalSummary } from './types'

export const AMA_BUDGETS = [512, 1024, 1536, 2400] as const
export const AMA_BUDGET_REPETITIONS = 3
export const AMA_BUDGET_QUALITY_TOLERANCE = 0.01

export interface MatrixRun {
  budget: number
  repetition: number
  report_id: string
  report_sha256: string
  summary: AmaEvalSummary
}

export function getComparisonConfiguration(summary: AmaEvalSummary) {
  const metadata = summary.metadata
  if (!metadata) {
    throw new Error('A budget run is missing metadata.')
  }
  const callSettings = { ...metadata.callSettings }
  delete callSettings.maxOutputTokens
  return {
    modelConfigSha256: metadata.modelConfigSha256,
    promptSha256: metadata.promptSha256,
    scorerSha256: metadata.scorerSha256,
    transportSha256: metadata.transportSha256,
    fixtureSha256: metadata.fixtureSha256,
    sdkVersion: metadata.sdkVersion,
    datasetSha256: metadata.datasetSha256,
    finalDatasetSha256: metadata.finalDatasetSha256,
    judgeModel: metadata.judgeModel,
    judgeModelConfig: metadata.judgeModelConfig,
    judgeCallSettings: metadata.judgeCallSettings,
    judgeRequired: metadata.judgeRequired,
    callSettings,
  }
}

function passesAllGates(summary: AmaEvalSummary): boolean {
  const metrics = summary.metrics
  return (
    summary.passed &&
    Boolean(metrics) &&
    summary.criticalFailures.length === 0 &&
    summary.results.every(
      (result) =>
        result.diagnostics?.protocolPassed === true &&
        result.diagnostics.wirePrivacyPassed === true &&
        result.diagnostics.serverFinishReceived === true &&
        result.diagnostics.finishReason === 'stop' &&
        result.output.trim() &&
        !result.diagnostics.errorKind &&
        result.judgeStatus !== 'error' &&
        result.judgeStatus !== 'skipped',
    ) &&
    [
      'emptyResponses',
      'truncatedResponses',
      'protocolFailures',
      'wirePrivacyFailures',
      'generationFailures',
      'judgeErrors',
      'judgeSkipped',
    ].every((key) => metrics![key as keyof typeof metrics] === 0)
  )
}

export function buildBudgetSelectionReport(runs: MatrixRun[]) {
  assertFrozenFinalSuite()
  if (runs.length !== AMA_BUDGETS.length * AMA_BUDGET_REPETITIONS) {
    throw new Error('A complete budget matrix requires all four budgets and three repetitions.')
  }
  const configuration = getComparisonConfiguration(runs[0]!.summary)
  if (
    configuration.datasetSha256 !== SELECTION_DATASET_SHA256 ||
    configuration.finalDatasetSha256 !== FINAL_RELEASE_DATASET_SHA256 ||
    !configuration.judgeRequired ||
    !configuration.judgeModel
  ) {
    throw new Error(
      'Budget selection requires the frozen selection dataset, final suite, and required judges.',
    )
  }
  const caseIds = amaEvalDataset.map((item) => item.id).sort()
  const seen = new Set<string>()
  for (const run of runs) {
    const key = `${run.budget}:${run.repetition}`
    if (
      !AMA_BUDGETS.some((budget) => budget === run.budget) ||
      !Number.isInteger(run.repetition) ||
      run.repetition < 1 ||
      run.repetition > AMA_BUDGET_REPETITIONS ||
      seen.has(key)
    ) {
      throw new Error('Budget matrix has invalid or duplicate repetitions.')
    }
    seen.add(key)
    const metadata = run.summary.metadata!
    if (
      metadata.profile !== 'tuning' ||
      metadata.partition !== 'selection' ||
      metadata.callSettings.maxOutputTokens !== run.budget ||
      metadata.repetition !== run.repetition ||
      run.summary.totalCases !== amaEvalDataset.length ||
      sha256(run.summary.results.map((item) => item.id).sort()) !== sha256(caseIds)
    ) {
      throw new Error('Budget matrix contains an incomplete or mismatched run.')
    }
    if (sha256(getComparisonConfiguration(run.summary)) !== sha256(configuration)) {
      throw new Error('Only maxOutputTokens may differ between budget runs.')
    }
  }
  const budgets = AMA_BUDGETS.map((budget) => {
    const matching = runs.filter((run) => run.budget === budget)
    return {
      budget,
      passing_every_repetition: matching.every((run) => passesAllGates(run.summary)),
      aggregate_quality:
        matching.reduce((sum, run) => sum + run.summary.weightedScore, 0) / matching.length,
      repetitions: matching.map((run) => ({
        repetition: run.repetition,
        report_id: run.report_id,
        report_sha256: run.report_sha256,
        passed: passesAllGates(run.summary),
        quality: run.summary.weightedScore,
        metrics: run.summary.metrics,
      })),
    }
  })
  const passing = budgets.filter((budget) => budget.passing_every_repetition)
  const bestQuality = passing.length
    ? Math.max(...passing.map((budget) => budget.aggregate_quality))
    : null
  const selected = passing.find(
    (budget) =>
      bestQuality! - budget.aggregate_quality <= AMA_BUDGET_QUALITY_TOLERANCE + Number.EPSILON,
  )
  const report = {
    schema_version: 1,
    report_type: 'ama_budget_selection',
    created_at: new Date().toISOString(),
    configuration,
    budgets,
    repetitions: AMA_BUDGET_REPETITIONS,
    quality_tolerance: AMA_BUDGET_QUALITY_TOLERANCE,
    selected_budget: selected?.budget ?? null,
    best_passing_quality: bestQuality,
    passed: Boolean(selected),
    rule: 'Smallest budget passing every gate in every repetition within 0.01 of the highest aggregate quality among passing budgets.',
  }
  return { ...report, selection_decision_sha256: sha256(report) }
}

export function validateSelectionReport(
  value: unknown,
): ReturnType<typeof buildBudgetSelectionReport> {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid selection report.')
  }
  const report = value as ReturnType<typeof buildBudgetSelectionReport>
  const { selection_decision_sha256, ...payload } = report
  if (
    report.report_type !== 'ama_budget_selection' ||
    sha256(payload) !== selection_decision_sha256 ||
    !report.passed ||
    !AMA_BUDGETS.some((budget) => budget === report.selected_budget)
  ) {
    throw new Error('Selection report is invalid, changed, or has no passing budget.')
  }
  return report
}

async function saveSelectionReport(runs: MatrixRun[]) {
  const report = buildBudgetSelectionReport(runs)
  const path = new URL(`selection-${Date.now()}-${randomUUID()}.json`, RESULTS_DIR)
  await mkdir(RESULTS_DIR, { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  console.log(`Selection report: ${path.pathname}`)
  console.log(
    report.selected_budget === null
      ? 'No budget passed every repetition. Keep the existing production setting.'
      : `Selected AMA_MAX_OUTPUT_TOKENS=${report.selected_budget}; run the frozen final suite before release.`,
  )
  return report
}

export async function runBudgetMatrix() {
  assertFrozenFinalSuite()
  const runs: MatrixRun[] = []
  const matrixId = `matrix-${Date.now()}-${randomUUID()}`
  // Interleave budgets by repetition to reduce time-of-run confounding.
  for (let repetition = 1; repetition <= AMA_BUDGET_REPETITIONS; repetition += 1) {
    for (const budget of AMA_BUDGETS) {
      console.log(
        `Budget matrix: ${budget} tokens, repetition ${repetition}/${AMA_BUDGET_REPETITIONS}`,
      )
      const summary = getRedactedSummary(
        await runAmaEvalSuite({
          profile: 'tuning',
          partition: 'selection',
          maxOutputTokens: budget,
          repetition,
          useJudge: true,
        }),
      )
      const evidence = buildBehavioralEvidence(summary, readEvidenceBindings('selection'))
      runs.push({
        budget,
        repetition,
        report_id: evidence.report_id,
        report_sha256: evidence.report_sha256,
        summary,
      })
      const payload = {
        schema_version: 1,
        report_type: 'ama_budget_matrix',
        matrix_id: matrixId,
        runs,
      }
      await writeFile(
        new URL(`${matrixId}.json`, RESULTS_DIR),
        `${JSON.stringify({ ...payload, matrix_sha256: sha256(payload) }, null, 2)}\n`,
      )
    }
  }
  return saveSelectionReport(runs)
}

/** Rebuild a selection decision from one complete saved matrix; makes no model calls. */
export async function selectSavedBudgetMatrix(file = process.env.AMA_EVAL_MATRIX_REPORT) {
  if (!file?.trim()) {
    throw new Error('AMA_EVAL_MATRIX_REPORT must name a complete saved matrix JSON file.')
  }
  const { matrix_sha256, ...matrix } = JSON.parse(await readFile(file, 'utf8')) as {
    matrix_sha256: string
    report_type: string
    runs: MatrixRun[]
  }
  if (matrix.report_type !== 'ama_budget_matrix' || sha256(matrix) !== matrix_sha256) {
    throw new Error('Saved matrix failed its integrity check.')
  }
  return saveSelectionReport(matrix.runs)
}
