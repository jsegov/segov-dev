import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { createAmaAgent } from '@/lib/ama-agent'
import { DEFAULT_AMA_CHAT_MODEL, type AmaModelConfig } from '@/lib/ama-model-config'
import { amaEvalDataset } from './dataset'
import {
  getPublicSiteFixture,
  getResumeFixture,
  searchPersonalContextFixture,
  searchWorkContextFixture,
} from './fixtures'
import {
  AMA_EVAL_THRESHOLDS,
  buildAmaEvalSummary,
  formatAmaEvalSummaryMarkdown,
  getSummaryFailureMessage,
  scoreAmaEvalCase,
} from './scorers'
import type { AmaEvalCaseResult, AmaEvalSummary, RunAmaEvalOptions } from './types'

const MODEL_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/
const PROVIDER_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RESULTS_DIR = new URL('./results/', import.meta.url)
const LATEST_RESULT_FILE = new URL('latest.json', RESULTS_DIR)

interface GenerateResultWithToolCalls {
  text: string
  toolCalls?: Array<{ toolName?: string }>
  steps?: Array<{
    toolCalls?: Array<{ toolName?: string }>
  }>
}

function parseModel(): string {
  const model =
    process.env.AMA_EVAL_MODEL?.trim() ||
    process.env.AMA_CHAT_MODEL?.trim() ||
    DEFAULT_AMA_CHAT_MODEL

  if (!MODEL_ID_PATTERN.test(model)) {
    throw new Error(`AMA eval model must use "provider/model-name" format. Received: "${model}"`)
  }

  return model
}

function parseProviders(): string[] | undefined {
  const configuredProviders =
    process.env.AMA_EVAL_PROVIDERS?.trim() || process.env.AMA_CHAT_PROVIDERS?.trim()

  if (!configuredProviders) {
    return undefined
  }

  const providers = Array.from(
    new Set(
      configuredProviders
        .split(',')
        .map((provider) => provider.trim())
        .filter(Boolean),
    ),
  )

  if (providers.length === 0) {
    return undefined
  }

  const invalidProvider = providers.find((provider) => !PROVIDER_SLUG_PATTERN.test(provider))
  if (invalidProvider) {
    throw new Error(`AMA eval providers contain invalid provider slug: "${invalidProvider}"`)
  }

  return providers
}

function getEvalModelConfig(): AmaModelConfig {
  const model = parseModel()
  const providers = parseProviders()

  if (!providers) {
    return { model }
  }

  return {
    model,
    providerOptions: {
      gateway: {
        order: providers,
        only: providers,
      },
    },
  }
}

function extractToolCalls(result: GenerateResultWithToolCalls): string[] {
  const toolCalls = [
    ...(result.toolCalls ?? []),
    ...(result.steps ?? []).flatMap((step) => step.toolCalls ?? []),
  ]
    .map((toolCall) => toolCall.toolName)
    .filter((toolName): toolName is string => Boolean(toolName))

  return Array.from(new Set(toolCalls))
}

function getRedactedSummary(summary: AmaEvalSummary): AmaEvalSummary {
  return {
    ...summary,
    results: summary.results.map((result) => ({
      ...result,
      output: result.redactedOutput,
    })),
  }
}

async function writeArtifacts(summary: AmaEvalSummary): Promise<void> {
  await mkdir(RESULTS_DIR, { recursive: true })
  await writeFile(LATEST_RESULT_FILE, `${JSON.stringify(getRedactedSummary(summary), null, 2)}\n`)

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${formatAmaEvalSummaryMarkdown(summary)}\n`)
  }
}

function logSummary(summary: AmaEvalSummary): void {
  console.log(formatAmaEvalSummaryMarkdown(summary))

  for (const result of summary.results.filter((caseResult) => !caseResult.passed)) {
    const failedScores = result.scores
      .filter((score) => !score.passed)
      .map((score) => `${score.name}: ${score.details}`)
      .join('; ')
    console.error(`${result.id} failed: ${failedScores}`)
    console.error(`Redacted output: ${result.redactedOutput.slice(0, 500)}`)
  }
}

export async function runAmaEvalSuite(options: RunAmaEvalOptions = {}): Promise<AmaEvalSummary> {
  const modelConfig = getEvalModelConfig()
  const useJudge = options.useJudge ?? process.env.AMA_EVAL_USE_JUDGE === '1'
  const judgeModel =
    options.judgeModel?.trim() || process.env.AMA_EVAL_JUDGE_MODEL?.trim() || modelConfig.model
  const agent = createAmaAgent({
    getPublicSiteContent: getPublicSiteFixture,
    getResumeContext: getResumeFixture,
    searchWorkContext: searchWorkContextFixture,
    searchPersonalContext: searchPersonalContextFixture,
    modelConfig,
    callSettings: {
      maxOutputTokens: Number(process.env.AMA_EVAL_MAX_OUTPUT_TOKENS ?? 240),
      temperature: 0,
      seed: 1,
      maxRetries: 1,
    },
  })

  const results: AmaEvalCaseResult[] = []
  for (const evalCase of amaEvalDataset) {
    const result = (await agent.generate({
      prompt: evalCase.prompt,
    })) as GenerateResultWithToolCalls
    results.push(
      await scoreAmaEvalCase(
        {
          case: evalCase,
          output: result.text,
          toolCalls: extractToolCalls(result),
          model: modelConfig.model,
        },
        { useJudge, judgeModel },
      ),
    )
  }

  const summary = buildAmaEvalSummary({
    modelConfig,
    results,
    thresholds: AMA_EVAL_THRESHOLDS,
  })

  await writeArtifacts(summary)
  logSummary(summary)

  if (options.enforceThresholds && !summary.passed) {
    throw new Error(getSummaryFailureMessage(summary))
  }

  return summary
}
