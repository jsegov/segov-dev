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
}

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
}
