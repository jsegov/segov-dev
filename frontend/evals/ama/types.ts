import type { AmaModelConfig } from '@/lib/ama-model-config'

export type AmaEvalCategory =
  | 'scope'
  | 'public_content'
  | 'resume'
  | 'work_privacy'
  | 'personal_projects'
  | 'fallbacks'
  | 'style'
  | 'conversation'

export type AmaEvalFixtureProfile = 'default' | 'context_unavailable' | 'public_unavailable'

export interface AmaEvalPriorMessage {
  role: 'user' | 'assistant'
  content: string
}

export type AmaEvalScoreName =
  | 'output_presence'
  | 'exact_match'
  | 'required_facts'
  | 'forbidden_leakage'
  | 'internal_tool_leakage'
  | 'tool_usage'
  | 'fallback_redirect'
  | 'first_person_voice'
  | 'style'
  | 'judge'
  | 'judge_completion'
  | 'stream_integrity'
  | 'output_completion'
  | 'tool_order'

export interface AmaEvalJudgeSpec {
  reference: string
  rubric: string
}

export interface AmaEvalCase {
  id: string
  category: AmaEvalCategory
  prompt: string
  /** Scripted earlier turns; the case's prompt becomes the final user message. */
  priorMessages?: AmaEvalPriorMessage[]
  /** Dependency set injected into the agent. Defaults to 'default'. */
  fixtureProfile?: AmaEvalFixtureProfile
  expectedExact?: string
  requiredSubstrings?: string[]
  forbiddenSubstrings?: string[]
  expectedTools?: string[]
  expectedToolOrder?: string[]
  disallowedTools?: string[]
  expectCareerProjectsRedirect?: boolean
  expectFirstPerson?: boolean
  maxWords?: number
  allowMarkdown?: boolean
  criticalScores?: AmaEvalScoreName[]
  judge?: AmaEvalJudgeSpec
}

export type AmaEvalUsage = Record<string, number>

export interface AmaEvalGenerationDiagnostics {
  finishReason?: string
  stepCount: number
  usage?: AmaEvalUsage
  totalUsage?: AmaEvalUsage
  stepFinishReasons: string[]
  latencyMs?: number
  firstTextTokenMs?: number
  errorKind?: string
  wirePrivacyPassed?: boolean
  protocolPassed?: boolean
  serverFinishReceived?: boolean
  toolSequence?: Array<{ step: number; name: string }>
  responseModel?: string
  provider?: string
}

export type AmaEvalProfile = 'production' | 'benchmark' | 'tuning'
export type AmaEvalPartition = 'selection' | 'final'
export type AmaEvalJudgeStatus = 'not_required' | 'skipped' | 'passed' | 'failed' | 'error'

export interface AmaEvalCaseRun {
  case: AmaEvalCase
  output: string
  toolCalls: string[]
  model: string
  diagnostics?: AmaEvalGenerationDiagnostics
}

export interface AmaEvalScore {
  name: AmaEvalScoreName
  score: number
  passed: boolean
  critical: boolean
  details: string
}

export interface AmaEvalCaseResult {
  id: string
  category: AmaEvalCategory
  prompt: string
  output: string
  redactedOutput: string
  toolCalls: string[]
  diagnostics?: AmaEvalGenerationDiagnostics
  scores: AmaEvalScore[]
  weightedScore: number
  passed: boolean
  criticalFailures: string[]
  judgeStatus?: AmaEvalJudgeStatus
}

export interface AmaEvalSummary {
  modelConfig: AmaModelConfig
  thresholds: AmaEvalThresholds
  generatedAt: string
  totalCases: number
  passedCases: number
  failedCases: number
  weightedScore: number
  categoryScores: Record<AmaEvalCategory, number>
  criticalFailures: Array<{
    caseId: string
    score: AmaEvalScoreName
    details: string
  }>
  passed: boolean
  results: AmaEvalCaseResult[]
  metadata?: AmaEvalRunMetadata
  metrics?: AmaEvalMetrics
}

export interface AmaEvalRunMetadata {
  runId: string
  profile: AmaEvalProfile
  partition: AmaEvalPartition
  datasetSha256: string
  selectionDatasetSha256: string
  finalDatasetSha256: string
  fixtureSha256: string
  scorerSha256: string
  promptSha256: string
  callSettings: Record<string, unknown>
  sdkVersion: string
  transportSha256: string
  modelConfigSha256: string
  promptManifestSha256: string
  judgeModel: string | null
  judgeModelConfig: AmaModelConfig | null
  judgeCallSettings?: Record<string, unknown>
  judgeRequired: boolean
  repetition: number
  startedAt: string
  completedAt: string
}

export interface AmaEvalMetrics {
  emptyResponses: number
  truncatedResponses: number
  protocolFailures: number
  wirePrivacyFailures: number
  generationFailures: number
  judgeErrors: number
  judgeSkipped: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  meanLatencyMs: number
  p95LatencyMs: number
  meanFirstTextTokenMs: number | null
  /** Cost is only reported when explicit per-million input/output prices are supplied. */
  estimatedCostUsd: number | null
}

export interface AmaEvalThresholds {
  minOverallScore: number
  minCategoryScore: number
  maxCriticalFailures: number
}

export interface RunAmaEvalOptions {
  enforceThresholds?: boolean
  useJudge?: boolean
  judgeModel?: string
  profile?: AmaEvalProfile
  partition?: AmaEvalPartition
  maxOutputTokens?: number
  repetition?: number
  writeArtifacts?: boolean
}
