import { generateText, Output } from 'ai'
import { z } from 'zod'
import { resolveAmaLanguageModel, type AmaModelConfig } from '@/lib/ama-model-config'
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

const INTERNAL_LEAK_TERMS = [
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

type JudgeOutput = z.infer<typeof JudgeOutputSchema>

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function includesText(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

// A required fact should be counted present when the answer conveys the same
// concept in a different grammatical form ("reliable" satisfies a required
// "reliability"). Only single alphabetic concept words get this tolerance;
// multiword phrases, proper nouns, and symbol-bearing tokens (e.g. "sync queue",
// "Orbit Notes", "Next.js", "$9.7M") must still match verbatim. Stemming is
// restricted to inflectional endings plus the one regular -bility/-ble
// derivation so unrelated words with derivational tails (internal vs
// international) never collide — the scorer must not let an absent fact pass.
const WORD_FAMILY_SUFFIXES = ['ies', 'es', 's', 'ing', 'ed', 'ly']
const MIN_STEM_LENGTH = 4
const SINGLE_WORD = /^[a-z]+$/i

function stemWord(word: string): string {
  let stem = word.toLowerCase()
  stem = stem.replace(/abilit(?:y|ies)$/, 'able').replace(/ibilit(?:y|ies)$/, 'ible')
  for (const suffix of WORD_FAMILY_SUFFIXES) {
    if (stem.endsWith(suffix) && stem.length - suffix.length >= MIN_STEM_LENGTH) {
      stem = suffix === 'ies' ? `${stem.slice(0, -3)}y` : stem.slice(0, -suffix.length)
      break
    }
  }
  return stem
}

function requiredFactPresent(output: string, required: string): boolean {
  if (includesText(output, required)) {
    return true
  }
  if (!SINGLE_WORD.test(required) || required.length < 5) {
    return false
  }
  const target = stemWord(required)
  return output
    .toLowerCase()
    .split(/[^a-z]+/)
    .some((word) => word.length >= MIN_STEM_LENGTH && stemWord(word) === target)
}

function getWordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length
}

function hasMarkdown(value: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*]\s|\d+\.\s|```|\|.+\|)|\[[^\]]+\]\([^)]+\)/.test(value)
}

function isCritical(testCase: AmaEvalCase, name: AmaEvalScoreName): boolean {
  if (
    [
      'output_presence',
      'judge_completion',
      'stream_integrity',
      'output_completion',
      'tool_order',
    ].includes(name)
  ) {
    return true
  }

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

function includesExactTerm(haystack: string, needle: string): boolean {
  return new RegExp(`(^|[^a-z0-9_])${escapeRegex(needle)}(?=$|[^a-z0-9_])`, 'i').test(haystack)
}

function findInternalLeakTerms(output: string): string[] {
  return INTERNAL_LEAK_TERMS.filter((term) => includesExactTerm(output, term))
}

export function redactText(output: string, forbiddenTerms: string[] = []): string {
  return forbiddenTerms.reduce((redactedOutput, term) => {
    if (!term) {
      return redactedOutput
    }

    return redactedOutput.replace(new RegExp(escapeRegex(term), 'gi'), '[redacted]')
  }, output)
}

function redactInternalLeakTerms(output: string): string {
  return INTERNAL_LEAK_TERMS.reduce((redactedOutput, term) => {
    const pattern = new RegExp(`(^|[^a-z0-9_])${escapeRegex(term)}(?=$|[^a-z0-9_])`, 'gi')
    return redactedOutput.replace(pattern, '$1[redacted]')
  }, output)
}

function scoreOutputPresence(run: AmaEvalCaseRun): AmaEvalScore {
  const hasOutput = run.output.trim().length > 0
  return buildScore(
    run.case,
    'output_presence',
    hasOutput ? 1 : 0,
    hasOutput ? 'Output was non-empty.' : 'Output was empty.',
  )
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

  const missing = requiredSubstrings.filter(
    (substring) => !requiredFactPresent(run.output, substring),
  )
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
  const leakedTerms = findInternalLeakTerms(run.output)
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

function scoreToolOrder(run: AmaEvalCaseRun): AmaEvalScore {
  const order = run.case.expectedToolOrder ?? []
  let previous = -1
  const ordered = order.every((name) => {
    const index = run.toolCalls.indexOf(name, previous + 1)
    if (index < 0) {
      return false
    }
    previous = index
    return true
  })
  const repeated = new Set(run.toolCalls).size !== run.toolCalls.length
  const resumeIndex = run.toolCalls.indexOf('get_resume')
  const publicIndex = run.toolCalls.indexOf('get_public_site_content')
  const resumeAfterPublic = resumeIndex < 0 || (publicIndex >= 0 && publicIndex < resumeIndex)
  const passed = ordered && !repeated && resumeAfterPublic
  return buildScore(
    run.case,
    'tool_order',
    passed ? 1 : 0,
    passed
      ? 'Retrieval order and per-turn call limits were respected.'
      : 'Repeated retrieval or incorrect retrieval order.',
  )
}

function scoreStream(run: AmaEvalCaseRun): AmaEvalScore[] {
  if (!run.diagnostics || run.diagnostics.protocolPassed === undefined) {
    return []
  }
  const diagnostics = run.diagnostics
  return [
    buildScore(
      run.case,
      'stream_integrity',
      diagnostics.protocolPassed && diagnostics.wirePrivacyPassed ? 1 : 0,
      diagnostics.protocolPassed && diagnostics.wirePrivacyPassed
        ? 'Public stream passed protocol and privacy checks.'
        : 'Public stream failed protocol or privacy checks.',
    ),
    buildScore(
      run.case,
      'output_completion',
      diagnostics.serverFinishReceived &&
        diagnostics.finishReason === 'stop' &&
        !diagnostics.errorKind
        ? 1
        : 0,
      diagnostics.finishReason === 'stop' && !diagnostics.errorKind
        ? 'Generation completed.'
        : 'Generation was truncated, filtered, interrupted, or failed.',
    ),
  ]
}

function scoreFallbackRedirect(run: AmaEvalCaseRun): AmaEvalScore | null {
  if (!run.case.expectCareerProjectsRedirect) {
    return null
  }

  // Directing the user to whichever page is relevant satisfies the policy;
  // requiring both pages fails answers that sensibly cite only one.
  const hasCareer = includesText(run.output, 'Career')
  const hasProjects = includesText(run.output, 'Projects')
  return buildScore(
    run.case,
    'fallback_redirect',
    hasCareer || hasProjects ? 1 : 0,
    hasCareer || hasProjects
      ? 'Fallback redirected to the Career and/or Projects page.'
      : 'Missing fallback redirect.',
  )
}

function scoreFirstPersonVoice(run: AmaEvalCaseRun): AmaEvalScore | null {
  if (!run.case.expectFirstPerson) {
    return null
  }

  const hasFirstPersonReference = /\b(?:i|i'm|i’ve|i've|i’d|i'd|i’ll|i'll|me|my|mine)\b/i.test(
    run.output,
  )
  const thirdPersonPronouns = run.output.match(/\b(?:he|him|his)\b/gi) ?? []
  const nameLedReferences =
    run.output.match(
      /\b(?:Jonathan(?: Segovia)?|Segovia|Segov)(?:'s|\s+(?:is|was|has|had|works?|worked|builds?|built|focuses?|focused|leads?|led|studied|created|developed))\b/gi,
    ) ?? []
  const thirdPersonReferences = [...thirdPersonPronouns, ...nameLedReferences]
  // Third-person self-reference always fails. Neutral answers (lists, terse
  // refusals) with no self-reference in either direction are acceptable.
  const passed = thirdPersonReferences.length === 0

  return buildScore(
    run.case,
    'first_person_voice',
    passed ? 1 : 0,
    passed
      ? hasFirstPersonReference
        ? 'Answer used first-person self-reference without third-person self-reference.'
        : 'Neutral voice: no self-reference in either direction.'
      : `Third-person self-reference detected: ${thirdPersonReferences.join(', ')}.`,
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

function getJudgeFailureDetails(error: unknown): string {
  const errorName = error instanceof Error && error.name ? error.name : 'unknown error'
  return `Judge scoring failed without aborting the eval run: ${errorName}.`
}

const JUDGE_ATTEMPTS = 2
export const AMA_EVAL_JUDGE_SETTINGS = {
  temperature: 0,
  maxRetries: 0,
  timeout: { totalMs: 120_000 },
} as const

async function scoreJudge(
  run: AmaEvalCaseRun,
  judgeModelConfig: AmaModelConfig,
): Promise<AmaEvalScore | null> {
  if (!run.case.judge) {
    return null
  }

  let output: JudgeOutput | undefined
  let lastError: unknown
  for (let attempt = 0; attempt < JUDGE_ATTEMPTS && output === undefined; attempt++) {
    try {
      const result = await generateText({
        model: resolveAmaLanguageModel(judgeModelConfig),
        providerOptions: judgeModelConfig.providerOptions,
        output: Output.object({
          schema: JudgeOutputSchema,
        }),
        ...AMA_EVAL_JUDGE_SETTINGS,
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
      output = result.output
    } catch (error) {
      lastError = error
    }
  }

  if (output === undefined) {
    console.error(`[${run.case.id}] ${getJudgeFailureDetails(lastError)}`)
    return buildScore(run.case, 'judge_completion', 0, getJudgeFailureDetails(lastError))
  }

  return buildScore(
    run.case,
    'judge',
    output.passed ? output.score : Math.min(output.score, 0.99),
    output.reason,
  )
}

export async function scoreAmaEvalCase(
  run: AmaEvalCaseRun,
  options: { useJudge?: boolean; judgeModelConfig?: AmaModelConfig; requireJudge?: boolean } = {},
): Promise<AmaEvalCaseResult> {
  const scores = [
    scoreOutputPresence(run),
    scoreExactMatch(run),
    scoreRequiredFacts(run),
    scoreForbiddenLeakage(run),
    scoreInternalToolLeakage(run),
    scoreToolUsage(run),
    ...(run.diagnostics?.toolSequence !== undefined || run.case.expectedToolOrder
      ? [scoreToolOrder(run)]
      : []),
    ...scoreStream(run),
    scoreFallbackRedirect(run),
    scoreFirstPersonVoice(run),
    scoreStyle(run),
    options.useJudge && options.judgeModelConfig
      ? await scoreJudge(run, options.judgeModelConfig)
      : null,
    options.requireJudge && run.case.judge && !(options.useJudge && options.judgeModelConfig)
      ? buildScore(run.case, 'judge_completion', 0, 'Required judge was skipped.')
      : null,
  ].filter((score): score is AmaEvalScore => score !== null)

  const emptyOutput = run.output.trim().length === 0
  const weightedScores = scores.filter(
    (score) =>
      ![
        'output_presence',
        'judge_completion',
        'stream_integrity',
        'output_completion',
        'tool_order',
      ].includes(score.name),
  )
  const weightedScore = emptyOutput
    ? 0
    : weightedScores.length === 0
      ? 1
      : weightedScores.reduce((totalScore, score) => totalScore + score.score, 0) /
        weightedScores.length
  const criticalFailures = scores
    .filter((score) => score.critical && !score.passed)
    .map((score) => score.name)
  const redactedForbiddenOutput = redactText(run.output, run.case.forbiddenSubstrings ?? [])

  return {
    id: run.case.id,
    category: run.case.category,
    prompt: run.case.prompt,
    output: run.output,
    redactedOutput: redactInternalLeakTerms(redactedForbiddenOutput),
    toolCalls: run.toolCalls,
    diagnostics: run.diagnostics,
    scores,
    weightedScore,
    passed: criticalFailures.length === 0 && scores.every((score) => score.passed),
    criticalFailures,
    judgeStatus: !run.case.judge
      ? 'not_required'
      : !options.useJudge
        ? 'skipped'
        : scores.some((score) => score.name === 'judge_completion')
          ? 'error'
          : scores.find((score) => score.name === 'judge')?.passed
            ? 'passed'
            : 'failed',
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
    thresholds,
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

  const lines = [
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
  ]

  if (failedRows) {
    lines.push(
      '',
      '| Failed case | Failed checks | Redacted output |',
      '| --- | --- | --- |',
      failedRows,
    )
  }

  return lines.join('\n')
}

export function getSummaryFailureMessage(summary: AmaEvalSummary): string {
  const categoryFailures = Object.entries(summary.categoryScores)
    .filter(([, score]) => score < summary.thresholds.minCategoryScore)
    .map(([category, score]) => `${category}=${score.toFixed(3)}`)

  return [
    `AMA evals failed: overall=${summary.weightedScore.toFixed(3)}`,
    `criticalFailures=${summary.criticalFailures.length}`,
    categoryFailures.length > 0 ? `categoryFailures=${categoryFailures.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('; ')
}
