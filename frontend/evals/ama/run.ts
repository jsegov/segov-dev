import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { createAmaAgent } from '@/lib/ama-agent'
import {
  createAmaInferenceModelConfig,
  createAmaModelConfig,
  DEFAULT_AMA_CHAT_MODEL,
  parseAmaModelId,
  parseAmaProviderSlugs,
  parseAmaReasoningEffort,
  type AmaModelConfig,
} from '@/lib/ama-model-config'
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
} from './fixtures'
import {
  AMA_EVAL_THRESHOLDS,
  buildAmaEvalSummary,
  formatAmaEvalSummaryMarkdown,
  getSummaryFailureMessage,
  scoreAmaEvalCase,
} from './scorers'
import type {
  AmaEvalCase,
  AmaEvalFixtureProfile,
  AmaEvalGenerationDiagnostics,
  AmaEvalSummary,
  RunAmaEvalOptions,
} from './types'

const RESULTS_DIR = new URL('./results/', import.meta.url)
const LATEST_RESULT_FILE = new URL('latest.json', RESULTS_DIR)

export const DEFAULT_AMA_EVAL_MAX_OUTPUT_TOKENS = 2400

export interface GenerateResultWithToolCalls {
  text: string
  finishReason?: string
  usage?: unknown
  totalUsage?: unknown
  toolCalls?: Array<{ toolName?: string }>
  steps?: Array<{
    finishReason?: string
    usage?: unknown
    toolCalls?: Array<{ toolName?: string }>
  }>
}

export function parsePositiveIntegerEnv(
  value: string | undefined,
  fallback: number,
  variableName: string,
): number {
  const trimmedValue = value?.trim()
  if (!trimmedValue) {
    return fallback
  }

  const parsedValue = Number(trimmedValue)
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${variableName} must be a positive integer. Received: "${value}".`)
  }

  return parsedValue
}

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

function parseModel(): string {
  const evalModel = process.env.AMA_EVAL_MODEL?.trim()
  const chatModel = process.env.AMA_CHAT_MODEL?.trim()

  return parseAmaModelId(
    evalModel || chatModel,
    DEFAULT_AMA_CHAT_MODEL,
    evalModel ? 'AMA_EVAL_MODEL' : 'AMA_CHAT_MODEL',
  )
}

function parseProviders(): string[] | undefined {
  const evalProviders = process.env.AMA_EVAL_PROVIDERS?.trim()
  const chatProviders = process.env.AMA_CHAT_PROVIDERS?.trim()

  return parseAmaProviderSlugs(
    evalProviders || chatProviders,
    evalProviders ? 'AMA_EVAL_PROVIDERS' : 'AMA_CHAT_PROVIDERS',
  )
}

function getEvalModelConfig(): AmaModelConfig {
  const inferenceBaseUrl = process.env.AMA_INFERENCE_BASE_URL?.trim()

  if (inferenceBaseUrl) {
    const evalModel = process.env.AMA_EVAL_MODEL?.trim()
    const model = evalModel || process.env.AMA_DEPLOYMENT_MODEL?.trim()
    if (!model) {
      throw new Error(
        'AMA_EVAL_MODEL or AMA_DEPLOYMENT_MODEL is required when AMA_INFERENCE_BASE_URL is set.',
      )
    }

    return createAmaInferenceModelConfig({
      model,
      baseURL: inferenceBaseUrl,
      reasoningEffort: parseAmaReasoningEffort(
        process.env.AMA_INFERENCE_REASONING_EFFORT,
        'AMA_INFERENCE_REASONING_EFFORT',
      ),
    })
  }

  const model = parseModel()
  const providers = parseProviders()
  return createAmaModelConfig(model, providers)
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

function extractToolCalls(result: GenerateResultWithToolCalls): string[] {
  const toolCalls = [
    ...(result.toolCalls ?? []),
    ...(result.steps ?? []).flatMap((step) => step.toolCalls ?? []),
  ]
    .map((toolCall) => toolCall.toolName)
    .filter((toolName): toolName is string => Boolean(toolName))

  return Array.from(new Set(toolCalls))
}

function sanitizeUsageMetadata(usage: unknown): Record<string, number> | undefined {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return undefined
  }

  const numericFields = Object.entries(usage).reduce(
    (fields, [key, value]) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        fields[key] = value
      }

      return fields
    },
    {} as Record<string, number>,
  )

  return Object.keys(numericFields).length > 0 ? numericFields : undefined
}

export function extractGenerationDiagnostics(
  result: GenerateResultWithToolCalls,
): AmaEvalGenerationDiagnostics {
  return {
    finishReason: typeof result.finishReason === 'string' ? result.finishReason : undefined,
    stepCount: result.steps?.length ?? 0,
    usage: sanitizeUsageMetadata(result.usage),
    totalUsage: sanitizeUsageMetadata(result.totalUsage),
    stepFinishReasons: (result.steps ?? [])
      .map((step) => step.finishReason)
      .filter((finishReason): finishReason is string => typeof finishReason === 'string'),
  }
}

export function getRedactedSummary(summary: AmaEvalSummary): AmaEvalSummary {
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
    if (result.diagnostics) {
      console.error(`Diagnostics: ${JSON.stringify(result.diagnostics)}`)
    }
  }
}

export async function runAmaEvalSuite(options: RunAmaEvalOptions = {}): Promise<AmaEvalSummary> {
  const modelConfig = getEvalModelConfig()
  const useJudge = options.useJudge ?? process.env.AMA_EVAL_USE_JUDGE === '1'
  // The judge always runs through the AI Gateway, even when the subject model
  // is served from an OpenAI-compatible inference endpoint — a fine-tuned
  // checkpoint must never grade itself with its narrow instruction tuning.
  const judgeModel =
    options.judgeModel?.trim() ||
    process.env.AMA_EVAL_JUDGE_MODEL?.trim() ||
    (modelConfig.inference ? DEFAULT_AMA_CHAT_MODEL : modelConfig.model)
  const judgeModelConfig = createAmaModelConfig(
    parseAmaModelId(judgeModel, DEFAULT_AMA_CHAT_MODEL, 'AMA_EVAL_JUDGE_MODEL'),
    parseProviders(),
  )
  if (useJudge && !(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN)) {
    throw new Error(
      'AMA_EVAL_USE_JUDGE requires AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN for the judge model.',
    )
  }
  const maxOutputTokens = parsePositiveIntegerEnv(
    process.env.AMA_EVAL_MAX_OUTPUT_TOKENS,
    DEFAULT_AMA_EVAL_MAX_OUTPUT_TOKENS,
    'AMA_EVAL_MAX_OUTPUT_TOKENS',
  )
  const concurrency = parsePositiveIntegerEnv(
    process.env.AMA_EVAL_CONCURRENCY,
    4,
    'AMA_EVAL_CONCURRENCY',
  )

  const results = await mapWithConcurrency(amaEvalDataset, concurrency, async (evalCase) => {
    const agent = createAmaAgent({
      ...getFixtureProfileDependencies(evalCase.fixtureProfile ?? 'default'),
      modelConfig,
      callSettings: {
        maxOutputTokens,
        temperature: 0,
        seed: 1,
        maxRetries: 1,
      },
    })
    const result = (await agent.generate(getGenerateInput(evalCase))) as GenerateResultWithToolCalls

    return scoreAmaEvalCase(
      {
        case: evalCase,
        output: result.text,
        toolCalls: extractToolCalls(result),
        model: modelConfig.model,
        diagnostics: extractGenerationDiagnostics(result),
      },
      { useJudge, judgeModelConfig },
    )
  })

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
