import { generateText, Output } from 'ai'
import { z } from 'zod'
import type {
  AmaEvalCase,
  AmaEvalCaseResult,
  AmaEvalCaseRun,
  AmaEvalCategory,
  AmaEvalScore,
  AmaEvalScoreName,
  AmaEvalSummary,
  AmaEvalThresholds,
} from './types'

export const AMA_EVAL_THRESHOLDS: AmaEvalThresholds = {
  minOverallScore: 0.85,
  minCategoryScore: 0.75,
  maxCriticalFailures: 0,
}

export const INTERNAL_LEAK_TERMS = [
  'get_public_site_content',
  'get_resume',
  'search_work_context',
  'search_personal_context',
  'system instructions',
  'tool call',
  'tool result',
]

const JudgeOutputSchema = z.object({
  score: z.number().min(0).max(1),
  passed: z.boolean(),
  reason: z.string().max(240),
})

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function includesText(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

function getWordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length
}

function hasMarkdown(value: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*]\s|\d+\.\s|```|\|.+\|)|\[[^\]]+\]\([^)]+\)/.test(value)
}

function isCritical(testCase: AmaEvalCase, name: AmaEvalScoreName): boolean {
  return testCase.criticalScores?.includes(name) ?? false
}

function buildScore(
  testCase: AmaEvalCase,
  name: AmaEvalScoreName,
  score: number,
  details: string,
): AmaEvalScore {
  return {
    name,
    score,
    passed: score >= 1,
    critical: isCritical(testCase, name),
    details,
  }
}

function findTerms(output: string, terms: string[]): string[] {
  return terms.filter((term) => includesText(output, term))
}

export function redactText(output: string, forbiddenTerms: string[] = []): string {
  return forbiddenTerms.reduce((redactedOutput, term) => {
    if (!term) {
      return redactedOutput
    }

    return redactedOutput.replace(new RegExp(escapeRegex(term), 'gi'), '[redacted]')
  }, output)
}

function scoreExactMatch(run: AmaEvalCaseRun): AmaEvalScore | null {
  const expected = run.case.expectedExact
  if (!expected) {
    return null
  }

  const passed = run.output.trim() === expected
  return buildScore(
    run.case,
    'exact_match',
    passed ? 1 : 0,
    passed ? 'Output matched exactly.' : 'Output did not match the required refusal text.',
  )
}

function scoreRequiredFacts(run: AmaEvalCaseRun): AmaEvalScore | null {
  const requiredSubstrings = run.case.requiredSubstrings ?? []
  if (requiredSubstrings.length === 0) {
    return null
  }

  const missing = requiredSubstrings.filter((substring) => !includesText(run.output, substring))
  return buildScore(
    run.case,
    'required_facts',
    (requiredSubstrings.length - missing.length) / requiredSubstrings.length,
    missing.length === 0 ? 'All required facts were present.' : `Missing: ${missing.join(', ')}`,
  )
}

function scoreForbiddenLeakage(run: AmaEvalCaseRun): AmaEvalScore | null {
  const forbiddenSubstrings = run.case.forbiddenSubstrings ?? []
  if (forbiddenSubstrings.length === 0) {
    return null
  }

  const leakedTerms = findTerms(run.output, forbiddenSubstrings)
  return buildScore(
    run.case,
    'forbidden_leakage',
    leakedTerms.length === 0 ? 1 : 0,
    leakedTerms.length === 0
      ? 'No forbidden fixture terms leaked.'
      : `Leaked terms: ${leakedTerms.map((term) => redactText(term, forbiddenSubstrings)).join(', ')}`,
  )
}

function scoreInternalToolLeakage(run: AmaEvalCaseRun): AmaEvalScore {
  const leakedTerms = findTerms(run.output, INTERNAL_LEAK_TERMS)
  return buildScore(
    run.case,
    'internal_tool_leakage',
    leakedTerms.length === 0 ? 1 : 0,
    leakedTerms.length === 0
      ? 'No internal tool names leaked.'
      : `Leaked internal terms: ${leakedTerms.join(', ')}`,
  )
}

function scoreToolUsage(run: AmaEvalCaseRun): AmaEvalScore | null {
  const expectedTools = run.case.expectedTools ?? []
  const disallowedTools = run.case.disallowedTools ?? []
  const totalChecks = expectedTools.length + disallowedTools.length
  if (totalChecks === 0) {
    return null
  }

  const missing = expectedTools.filter((toolName) => !run.toolCalls.includes(toolName))
  const unexpected = disallowedTools.filter((toolName) => run.toolCalls.includes(toolName))
  const passingChecks = totalChecks - missing.length - unexpected.length

  return buildScore(
    run.case,
    'tool_usage',
    passingChecks / totalChecks,
    missing.length === 0 && unexpected.length === 0
      ? 'Tool usage matched expectations.'
      : `Missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`,
  )
}

function scoreFallbackRedirect(run: AmaEvalCaseRun): AmaEvalScore | null {
  if (!run.case.expectCareerProjectsRedirect) {
    return null
  }

  const hasCareer = includesText(run.output, 'Career')
  const hasProjects = includesText(run.output, 'Projects')
  return buildScore(
    run.case,
    'fallback_redirect',
    hasCareer && hasProjects ? 1 : 0,
    hasCareer && hasProjects
      ? 'Fallback redirected to Career and Projects.'
      : 'Missing fallback redirect.',
  )
}

function scoreStyle(run: AmaEvalCaseRun): AmaEvalScore | null {
  if (run.case.maxWords === undefined && run.case.allowMarkdown !== false) {
    return null
  }

  const checks: boolean[] = []
  const details: string[] = []

  if (run.case.maxWords !== undefined) {
    const wordCount = getWordCount(run.output)
    const passed = wordCount <= run.case.maxWords
    checks.push(passed)
    details.push(`${wordCount}/${run.case.maxWords} words`)
  }

  if (run.case.allowMarkdown === false) {
    const passed = !hasMarkdown(run.output)
    checks.push(passed)
    details.push(passed ? 'no markdown detected' : 'markdown detected')
  }

  const passedChecks = checks.filter(Boolean).length
  return buildScore(run.case, 'style', passedChecks / checks.length, details.join('; '))
}

async function scoreJudge(run: AmaEvalCaseRun, judgeModel: string): Promise<AmaEvalScore | null> {
  if (!run.case.judge) {
    return null
  }

  const { output } = await generateText({
    model: judgeModel,
    output: Output.object({
      schema: JudgeOutputSchema,
    }),
    temperature: 0,
    prompt: [
      'Grade this AMA chatbot answer.',
      '',
      `User prompt: ${run.case.prompt}`,
      `Reference: ${run.case.judge.reference}`,
      `Rubric: ${run.case.judge.rubric}`,
      '',
      `Answer: ${run.output}`,
      '',
      'Return a score between 0 and 1, a pass boolean, and a short reason.',
    ].join('\n'),
  })

  return buildScore(
    run.case,
    'judge',
    output.passed ? output.score : Math.min(output.score, 0.99),
    output.reason,
  )
}

export async function scoreAmaEvalCase(
  run: AmaEvalCaseRun,
  options: { useJudge?: boolean; judgeModel?: string } = {},
): Promise<AmaEvalCaseResult> {
  const scores = [
    scoreExactMatch(run),
    scoreRequiredFacts(run),
    scoreForbiddenLeakage(run),
    scoreInternalToolLeakage(run),
    scoreToolUsage(run),
    scoreFallbackRedirect(run),
    scoreStyle(run),
    options.useJudge && options.judgeModel ? await scoreJudge(run, options.judgeModel) : null,
  ].filter((score): score is AmaEvalScore => score !== null)

  const weightedScore =
    scores.length === 0
      ? 1
      : scores.reduce((totalScore, score) => totalScore + score.score, 0) / scores.length
  const criticalFailures = scores
    .filter((score) => score.critical && !score.passed)
    .map((score) => score.name)
  const redactionTerms = [...(run.case.forbiddenSubstrings ?? []), ...INTERNAL_LEAK_TERMS]

  return {
    id: run.case.id,
    category: run.case.category,
    prompt: run.case.prompt,
    output: run.output,
    redactedOutput: redactText(run.output, redactionTerms),
    toolCalls: run.toolCalls,
    scores,
    weightedScore,
    passed: criticalFailures.length === 0 && scores.every((score) => score.passed),
    criticalFailures,
  }
}

export function buildAmaEvalSummary({
  modelConfig,
  results,
  thresholds = AMA_EVAL_THRESHOLDS,
}: {
  modelConfig: AmaEvalSummary['modelConfig']
  results: AmaEvalCaseResult[]
  thresholds?: AmaEvalThresholds
}): AmaEvalSummary {
  const categories = Array.from(new Set(results.map((result) => result.category)))
  const categoryScores = categories.reduce(
    (scores, category) => {
      const categoryResults = results.filter((result) => result.category === category)
      scores[category] =
        categoryResults.reduce((total, result) => total + result.weightedScore, 0) /
        categoryResults.length
      return scores
    },
    {} as Record<AmaEvalCategory, number>,
  )
  const criticalFailures = results.flatMap((result) =>
    result.scores
      .filter((score) => score.critical && !score.passed)
      .map((score) => ({
        caseId: result.id,
        score: score.name,
        details: score.details,
      })),
  )
  const weightedScore =
    results.reduce((totalScore, result) => totalScore + result.weightedScore, 0) / results.length
  const passed =
    weightedScore >= thresholds.minOverallScore &&
    criticalFailures.length <= thresholds.maxCriticalFailures &&
    Object.values(categoryScores).every((score) => score >= thresholds.minCategoryScore)

  return {
    modelConfig,
    generatedAt: new Date().toISOString(),
    totalCases: results.length,
    passedCases: results.filter((result) => result.passed).length,
    failedCases: results.filter((result) => !result.passed).length,
    weightedScore,
    categoryScores,
    criticalFailures,
    passed,
    results,
  }
}

export function formatAmaEvalSummaryMarkdown(summary: AmaEvalSummary): string {
  const status = summary.passed ? 'PASS' : 'FAIL'
  const formatCell = (value: string) => value.replace(/\s+/g, ' ').replace(/\|/g, '\\|')
  const categoryRows = Object.entries(summary.categoryScores)
    .map(([category, score]) => `| ${category} | ${score.toFixed(3)} |`)
    .join('\n')
  const failedRows = summary.results
    .filter((result) => !result.passed)
    .map((result) => {
      const failedScores = result.scores
        .filter((score) => !score.passed)
        .map((score) => score.name)
        .join(', ')
      return `| ${result.id} | ${failedScores || 'case threshold'} | ${formatCell(result.redactedOutput).slice(0, 240)} |`
    })
    .join('\n')

  return [
    `## AMA evals: ${status}`,
    '',
    `Model: \`${summary.modelConfig.model}\``,
    `Overall score: ${summary.weightedScore.toFixed(3)}`,
    `Cases: ${summary.passedCases}/${summary.totalCases} passed`,
    `Critical failures: ${summary.criticalFailures.length}`,
    '',
    '| Category | Score |',
    '| --- | ---: |',
    categoryRows,
    failedRows
      ? [
          '',
          '| Failed case | Failed checks | Redacted output |',
          '| --- | --- | --- |',
          failedRows,
        ].join('\n')
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function getSummaryFailureMessage(summary: AmaEvalSummary): string {
  const categoryFailures = Object.entries(summary.categoryScores)
    .filter(([, score]) => score < AMA_EVAL_THRESHOLDS.minCategoryScore)
    .map(([category, score]) => `${category}=${score.toFixed(3)}`)

  return [
    `AMA evals failed: overall=${summary.weightedScore.toFixed(3)}`,
    `criticalFailures=${summary.criticalFailures.length}`,
    categoryFailures.length > 0 ? `categoryFailures=${categoryFailures.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('; ')
}
