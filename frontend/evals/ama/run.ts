import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises'
import type { createAmaAgent } from '@/lib/ama-agent'
import { AMA_TOOL_DECLARATIONS, createAmaPromptManifest } from '@/lib/ama-agent'
import {
  getAmaModelConfig,
  createAmaModelConfig,
  createAmaInferenceModelConfig,
  DEFAULT_AMA_CHAT_MODEL,
  parseAmaModelId,
  parseAmaProviderSlugs,
  parseAmaReasoningEffort,
  type AmaModelConfig,
} from '@/lib/ama-model-config'
import { getAmaStreamErrorDetails } from '@/lib/ama-stream-diagnostics'
import { assertExplicitCiModelConfig } from './ci-config'
import { amaEvalDataset } from './dataset'
import {
  getPublicSiteFixture,
  getPublicSiteUnavailableFixture,
  getResumeFixture,
  getResumeUnavailableFixture,
  searchPersonalContextFixture,
  searchPersonalContextUnavailableFixture,
  searchWorkContextFixture,
  searchWorkContextUnavailableFixture,
  sanitizedForbiddenTerms,
} from './fixtures'
import {
  AMA_EVAL_THRESHOLDS,
  AMA_EVAL_JUDGE_SETTINGS,
  buildAmaEvalSummary,
  formatAmaEvalSummaryMarkdown,
  getSummaryFailureMessage,
  scoreAmaEvalCase,
  redactText,
} from './scorers'
import {
  getEvalProfile,
  getEvalPartition,
  getEvalCallSettings,
  parsePositiveIntegerEnv,
} from './profiles'
import { generatePublicEvalCase } from './stream'
import {
  assertFrozenFinalSuite,
  finalReleaseDataset,
  getFinalFixtureDependencies,
  FINAL_RELEASE_DATASET_SHA256,
} from './release'
import { hashFiles, sha256 } from './hashes'
import { readEvidenceBindings, buildBehavioralEvidence, buildEvalMetrics } from './evidence'
import frozen from './final-release.json'
import { verifyCheckpointDecision } from './checkpoint-decision'
import type {
  AmaEvalCase,
  AmaEvalFixtureProfile,
  AmaEvalProfile,
  AmaEvalSummary,
  RunAmaEvalOptions,
} from './types'

export { DEFAULT_AMA_EVAL_MAX_OUTPUT_TOKENS, parsePositiveIntegerEnv } from './profiles'
export {
  extractGenerationDiagnostics,
  extractToolCalls,
  type GenerateResultWithToolCalls,
} from './stream'
export const RESULTS_DIR = new URL('./results/', import.meta.url)
export const SELECTION_DATASET_SHA256 = sha256(amaEvalDataset)

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  callback: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await callback(items[currentIndex], currentIndex)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => worker()),
  )
  return results
}

export function getEvalModelConfig(profile: AmaEvalProfile): AmaModelConfig {
  assertExplicitCiModelConfig()
  if (profile !== 'benchmark') {
    if (process.env.AMA_EVAL_MODEL?.trim() || process.env.AMA_EVAL_PROVIDERS?.trim()) {
      throw new Error(
        'AMA_EVAL_MODEL and AMA_EVAL_PROVIDERS are benchmark-only. Production and tuning use the runtime configuration.',
      )
    }
    return getAmaModelConfig()
  }
  const model =
    process.env.AMA_EVAL_MODEL?.trim() ||
    (process.env.AMA_INFERENCE_BASE_URL?.trim()
      ? process.env.AMA_DEPLOYMENT_MODEL?.trim()
      : process.env.AMA_CHAT_MODEL?.trim())
  if (process.env.AMA_INFERENCE_BASE_URL?.trim()) {
    if (!model) {
      throw new Error('AMA_DEPLOYMENT_MODEL is required for inference evaluations.')
    }
    return createAmaInferenceModelConfig({
      model,
      baseURL: process.env.AMA_INFERENCE_BASE_URL,
      reasoningEffort: parseAmaReasoningEffort(
        process.env.AMA_INFERENCE_REASONING_EFFORT,
        'AMA_INFERENCE_REASONING_EFFORT',
      ),
    })
  }
  return createAmaModelConfig(
    parseAmaModelId(model, DEFAULT_AMA_CHAT_MODEL, 'AMA_EVAL_MODEL'),
    parseAmaProviderSlugs(
      process.env.AMA_EVAL_PROVIDERS || process.env.AMA_CHAT_PROVIDERS,
      'AMA_EVAL_PROVIDERS',
    ),
  )
}

type FixtureProfileDependencies = Pick<
  Parameters<typeof createAmaAgent>[0] & object,
  'getPublicSiteContent' | 'getResumeContext' | 'searchWorkContext' | 'searchPersonalContext'
>

const FIXTURE_PROFILES: Record<AmaEvalFixtureProfile, FixtureProfileDependencies> = {
  default: {
    getPublicSiteContent: getPublicSiteFixture,
    getResumeContext: getResumeFixture,
    searchWorkContext: searchWorkContextFixture,
    searchPersonalContext: searchPersonalContextFixture,
  },
  context_unavailable: {
    getPublicSiteContent: getPublicSiteFixture,
    getResumeContext: getResumeUnavailableFixture,
    searchWorkContext: searchWorkContextUnavailableFixture,
    searchPersonalContext: searchPersonalContextUnavailableFixture,
  },
  public_unavailable: {
    getPublicSiteContent: getPublicSiteUnavailableFixture,
    getResumeContext: getResumeFixture,
    searchWorkContext: searchWorkContextFixture,
    searchPersonalContext: searchPersonalContextFixture,
  },
}

export function getFixtureProfileDependencies(
  fixtureProfile: AmaEvalFixtureProfile,
): FixtureProfileDependencies {
  return FIXTURE_PROFILES[fixtureProfile]
}

export function getGenerateInput(
  evalCase: AmaEvalCase,
): { prompt: string } | { messages: Array<{ role: 'user' | 'assistant'; content: string }> } {
  const priorMessages = evalCase.priorMessages ?? []
  if (priorMessages.length === 0) {
    return { prompt: evalCase.prompt }
  }

  return {
    messages: [...priorMessages, { role: 'user', content: evalCase.prompt }],
  }
}

export function getRedactedSummary(summary: AmaEvalSummary): AmaEvalSummary {
  const terms = [
    ...sanitizedForbiddenTerms,
    ...frozen.forbidden_terms,
    ...summary.results.flatMap((result) => {
      const evalCase = [...amaEvalDataset, ...finalReleaseDataset].find(
        (item) => item.id === result.id,
      )
      return evalCase?.forbiddenSubstrings ?? []
    }),
  ]
  const safe = {
    ...summary,
    results: summary.results.map((result) => ({ ...result, output: result.redactedOutput })),
  }
  // Redact private canaries from diagnostics and judge explanations as well as complete answers.
  const redacted = JSON.parse(
    JSON.stringify(safe, (_key, value: unknown) =>
      typeof value === 'string' ? redactText(value, terms) : value,
    ),
  ) as AmaEvalSummary
  // Declared tool names are public code identifiers, not retrieval payloads.
  // Keep their order reviewable even when an answer-text case forbids naming tools.
  const knownTools = new Set<string>(AMA_TOOL_DECLARATIONS.map((tool) => tool.name))
  for (let index = 0; index < summary.results.length; index += 1) {
    const source = summary.results[index]!
    const target = redacted.results[index]!
    target.toolCalls = source.toolCalls.map((name) =>
      knownTools.has(name) ? name : redactText(name, terms),
    )
    if (source.diagnostics?.toolSequence && target.diagnostics) {
      target.diagnostics.toolSequence = source.diagnostics.toolSequence.map(({ step, name }) => ({
        step,
        name: knownTools.has(name) ? name : redactText(name, terms),
      }))
    }
  }
  if (redacted.modelConfig.inference) {
    const url = new URL(redacted.modelConfig.inference.baseURL)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    redacted.modelConfig.inference.baseURL = url.toString()
  }
  return redacted
}

async function writeArtifacts(
  summary: AmaEvalSummary,
  bindings: ReturnType<typeof readEvidenceBindings>,
): Promise<void> {
  await mkdir(RESULTS_DIR, { recursive: true })
  const evidence = buildBehavioralEvidence(getRedactedSummary(summary), bindings)
  const json = `${JSON.stringify(evidence, null, 2)}\n`
  const file = new URL(`${summary.metadata!.runId}.json`, RESULTS_DIR)
  await writeFile(file, json, { flag: 'wx' })
  const requestedOutput = process.env.AMA_EVAL_OUTPUT_PATH?.trim()
  if (requestedOutput) {
    const outputPath = resolve(requestedOutput)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, json, { flag: 'wx' })
  }
  await writeFile(new URL('latest.json', RESULTS_DIR), json)
  console.log(`Evidence: ${file.pathname}`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${formatAmaEvalSummaryMarkdown(summary)}\n`)
  }
}

async function verifyFinalDecision(
  summaryConfig: { modelConfig: AmaModelConfig; metadata: NonNullable<AmaEvalSummary['metadata']> },
  bindings: ReturnType<typeof readEvidenceBindings>,
): Promise<void> {
  const file = process.env.AMA_EVAL_SELECTION_REPORT?.trim()
  const checkpointFile = process.env.AMA_EVAL_CHECKPOINT_DECISION?.trim()
  if (checkpointFile) {
    if (file) {
      throw new Error('Specify only one frozen selection decision file.')
    }
    verifyCheckpointDecision(
      JSON.parse(await readFile(checkpointFile, 'utf8')),
      summaryConfig.modelConfig,
      summaryConfig.metadata,
      bindings,
    )
    return
  }
  if (!file || bindings.candidate_id) {
    throw new Error('Candidate final evaluation requires AMA_EVAL_CHECKPOINT_DECISION.')
  }
  const { validateSelectionReport, getComparisonConfiguration } = await import('./matrix')
  const report = validateSelectionReport(JSON.parse(await readFile(file, 'utf8')))
  const comparison = getComparisonConfiguration({
    metadata: summaryConfig.metadata,
  } as AmaEvalSummary)
  if (
    report.selected_budget !== summaryConfig.metadata.callSettings.maxOutputTokens ||
    report.configuration.modelConfigSha256 !== summaryConfig.metadata.modelConfigSha256 ||
    report.configuration.promptSha256 !== summaryConfig.metadata.promptSha256 ||
    report.configuration.scorerSha256 !== summaryConfig.metadata.scorerSha256 ||
    report.configuration.transportSha256 !== summaryConfig.metadata.transportSha256 ||
    report.configuration.fixtureSha256 !==
      (await hashFiles([new URL('./fixtures.ts', import.meta.url)])) ||
    report.configuration.finalDatasetSha256 !== FINAL_RELEASE_DATASET_SHA256 ||
    report.configuration.sdkVersion !== summaryConfig.metadata.sdkVersion ||
    sha256(report.configuration.callSettings) !== sha256(comparison.callSettings) ||
    sha256(report.configuration.judgeModelConfig) !== sha256(comparison.judgeModelConfig) ||
    sha256(report.configuration.judgeCallSettings) !== sha256(comparison.judgeCallSettings)
  ) {
    throw new Error('Final evaluation configuration does not match the frozen selection decision.')
  }
  if (
    bindings.selection_decision_sha256 &&
    bindings.selection_decision_sha256 !== report.selection_decision_sha256
  ) {
    throw new Error('Conflicting selection decision hashes.')
  }
  bindings.selection_decision_sha256 = report.selection_decision_sha256
}

export async function runAmaEvalSuite(options: RunAmaEvalOptions = {}): Promise<AmaEvalSummary> {
  assertFrozenFinalSuite()
  const profile = options.profile ?? getEvalProfile()
  const partition = options.partition ?? getEvalPartition()
  if (partition === 'final' && profile !== 'production') {
    throw new Error('The frozen final suite can only run with the production profile.')
  }
  const bindings = readEvidenceBindings(partition)
  const modelConfig = getEvalModelConfig(profile)
  const callSettings = getEvalCallSettings(modelConfig, profile, options.maxOutputTokens)
  const useJudge =
    options.useJudge ??
    (process.env.AMA_EVAL_USE_JUDGE
      ? process.env.AMA_EVAL_USE_JUDGE === '1'
      : profile !== 'benchmark')
  const judgeRequired = profile !== 'benchmark' || partition === 'final'
  const judgeModel = parseAmaModelId(
    options.judgeModel?.trim() || process.env.AMA_EVAL_JUDGE_MODEL?.trim(),
    DEFAULT_AMA_CHAT_MODEL,
    'AMA_EVAL_JUDGE_MODEL',
  )
  // The judge is independent of subject routing, including fine-tuned inference endpoints.
  const judgeModelConfig = createAmaModelConfig(
    judgeModel,
    parseAmaProviderSlugs(process.env.AMA_EVAL_JUDGE_PROVIDERS, 'AMA_EVAL_JUDGE_PROVIDERS'),
  )
  if (useJudge && !(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN)) {
    throw new Error('AMA eval judges require AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN.')
  }
  const concurrency = parsePositiveIntegerEnv(
    process.env.AMA_EVAL_CONCURRENCY,
    4,
    'AMA_EVAL_CONCURRENCY',
  )
  const dataset = partition === 'selection' ? amaEvalDataset : finalReleaseDataset
  const startedAt = new Date().toISOString()
  const promptManifest = createAmaPromptManifest(callSettings)
  const metadata: NonNullable<AmaEvalSummary['metadata']> = {
    runId: `${partition}-${profile}-${Date.now()}-${randomUUID()}`,
    profile,
    partition,
    datasetSha256:
      partition === 'selection' ? SELECTION_DATASET_SHA256 : FINAL_RELEASE_DATASET_SHA256,
    selectionDatasetSha256: SELECTION_DATASET_SHA256,
    finalDatasetSha256: FINAL_RELEASE_DATASET_SHA256,
    fixtureSha256: await hashFiles(
      partition === 'selection'
        ? [new URL('./fixtures.ts', import.meta.url)]
        : [
            new URL('./final-release.json', import.meta.url),
            new URL('./release.ts', import.meta.url),
          ],
    ),
    scorerSha256: await hashFiles([new URL('./scorers.ts', import.meta.url)]),
    transportSha256: await hashFiles([
      new URL('./stream.ts', import.meta.url),
      new URL('../../lib/ama-public-stream.ts', import.meta.url),
      new URL('../../lib/ama-request-budget.ts', import.meta.url),
      new URL('../../lib/ama-wake.ts', import.meta.url),
      new URL('../../lib/ama-agent.ts', import.meta.url),
      new URL('./profiles.ts', import.meta.url),
      new URL('./release.ts', import.meta.url),
    ]),
    promptSha256: sha256({
      instructions: promptManifest.instructions,
      tools: promptManifest.tools,
    }),
    promptManifestSha256: sha256(promptManifest),
    modelConfigSha256: sha256(modelConfig),
    callSettings: { ...callSettings },
    sdkVersion: (
      JSON.parse(
        await readFile(new URL('../../node_modules/ai/package.json', import.meta.url), 'utf8'),
      ) as { version: string }
    ).version,
    judgeModel: useJudge ? judgeModel : null,
    judgeModelConfig: useJudge ? judgeModelConfig : null,
    judgeCallSettings: { ...AMA_EVAL_JUDGE_SETTINGS, attempts: 2 },
    judgeRequired,
    repetition: options.repetition ?? 1,
    startedAt,
    completedAt: startedAt,
  }
  if (partition === 'final') {
    await verifyFinalDecision({ modelConfig, metadata }, bindings)
  }
  // Validate optional cost inputs before starting any paid work.
  buildEvalMetrics({ results: [] } as unknown as AmaEvalSummary)
  const results = await mapWithConcurrency(dataset, concurrency, async (evalCase) => {
    let generation: Awaited<ReturnType<typeof generatePublicEvalCase>>
    try {
      generation = await generatePublicEvalCase(evalCase, {
        ...(partition === 'selection'
          ? getFixtureProfileDependencies(evalCase.fixtureProfile ?? 'default')
          : getFinalFixtureDependencies(evalCase.fixtureProfile ?? 'default')),
        modelConfig,
        callSettings,
      })
    } catch (error) {
      generation = {
        output: '',
        toolCalls: [],
        diagnostics: {
          stepCount: 0,
          stepFinishReasons: [],
          errorKind: getAmaStreamErrorDetails(error, 'server_stream').errorKind,
          protocolPassed: false,
          wirePrivacyPassed: false,
          serverFinishReceived: false,
          toolSequence: [],
        },
      }
    }
    return scoreAmaEvalCase(
      { case: evalCase, ...generation, model: modelConfig.model },
      { useJudge, judgeModelConfig, requireJudge: judgeRequired },
    )
  })
  const summary = buildAmaEvalSummary({ modelConfig, results, thresholds: AMA_EVAL_THRESHOLDS })
  summary.metadata = { ...metadata, completedAt: new Date().toISOString() }
  summary.metrics = buildEvalMetrics(summary)
  if (options.writeArtifacts !== false) {
    await writeArtifacts(summary, bindings)
  }
  console.log(formatAmaEvalSummaryMarkdown(getRedactedSummary(summary)))
  if (options.enforceThresholds && !summary.passed) {
    throw new Error(getSummaryFailureMessage(summary))
  }
  return summary
}
