import type { AmaModelConfig } from '@/lib/ama-model-config'

export type AmaEvalCategory =
  | 'scope'
  | 'public_content'
  | 'resume'
  | 'work_privacy'
  | 'personal_projects'
  | 'fallbacks'
  | 'style'

export type AmaEvalScoreName =
  | 'exact_match'
  | 'required_facts'
  | 'forbidden_leakage'
  | 'internal_tool_leakage'
  | 'tool_usage'
  | 'fallback_redirect'
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
  expectedExact?: string
  requiredSubstrings?: string[]
  forbiddenSubstrings?: string[]
  expectedTools?: string[]
  disallowedTools?: string[]
  expectCareerProjectsRedirect?: boolean
  maxWords?: number
  allowMarkdown?: boolean
  criticalScores?: AmaEvalScoreName[]
  judge?: AmaEvalJudgeSpec
}

export interface AmaEvalCaseRun {
  case: AmaEvalCase
  output: string
  toolCalls: string[]
  model: string
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
  scores: AmaEvalScore[]
  weightedScore: number
  passed: boolean
  criticalFailures: string[]
}

export interface AmaEvalSummary {
  modelConfig: AmaModelConfig
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
