import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AMA_EVAL_MAX_OUTPUT_TOKENS,
  extractGenerationDiagnostics,
  getRedactedSummary,
  mapWithConcurrency,
  parsePositiveIntegerEnv,
} from '@/evals/ama/run'
import type { AmaEvalGenerationDiagnostics, AmaEvalSummary } from '@/evals/ama/types'
import { amaEvalDataset } from '@/evals/ama/dataset'
import { sanitizedForbiddenTerms } from '@/evals/ama/fixtures'

describe('AMA eval runner helpers', () => {
  it('preserves the historical 2400-token benchmark budget', () => {
    expect(DEFAULT_AMA_EVAL_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(2400)
  })

  it('parses positive integer env values with safe fallback behavior', () => {
    expect(parsePositiveIntegerEnv(undefined, 240, 'TEST_VALUE')).toBe(240)
    expect(parsePositiveIntegerEnv('', 240, 'TEST_VALUE')).toBe(240)
    expect(parsePositiveIntegerEnv(' 12 ', 240, 'TEST_VALUE')).toBe(12)
    expect(() => parsePositiveIntegerEnv('0', 240, 'TEST_VALUE')).toThrow(
      'TEST_VALUE must be a positive integer',
    )
    expect(() => parsePositiveIntegerEnv('NaN', 240, 'TEST_VALUE')).toThrow(
      'TEST_VALUE must be a positive integer',
    )
  })

  it('maps results with a concurrency limit while preserving input order', async () => {
    let activeTasks = 0
    let maxActiveTasks = 0

    const results = await mapWithConcurrency([3, 1, 2, 4], 2, async (value) => {
      activeTasks += 1
      maxActiveTasks = Math.max(maxActiveTasks, activeTasks)
      await Promise.resolve()
      activeTasks -= 1
      return value * 2
    })

    expect(results).toEqual([6, 2, 4, 8])
    expect(maxActiveTasks).toBeLessThanOrEqual(2)
  })

  it('extracts safe generation diagnostics from agent results', () => {
    const diagnostics = extractGenerationDiagnostics({
      text: 'Jonathan builds developer tools.',
      finishReason: 'stop',
      usage: {
        inputTokens: 42,
        outputTokens: 8,
        totalTokens: 50,
        prompt: 'do not serialize this',
        nested: { outputTokens: 99 },
        invalid: Number.NaN,
      },
      totalUsage: {
        inputTokens: 60,
        outputTokens: 10,
        totalTokens: 70,
        providerResponse: 'do not serialize this',
      },
      steps: [
        {
          finishReason: 'tool-calls',
          usage: { inputTokens: 20 },
          toolCalls: [{ toolName: 'get_public_site_content' }],
        },
        {
          finishReason: 'stop',
          toolCalls: [],
        },
      ],
    })

    expect(diagnostics).toEqual({
      finishReason: 'stop',
      stepCount: 2,
      usage: {
        inputTokens: 42,
        outputTokens: 8,
        totalTokens: 50,
      },
      totalUsage: {
        inputTokens: 60,
        outputTokens: 10,
        totalTokens: 70,
      },
      stepFinishReasons: ['tool-calls', 'stop'],
      toolOutcomes: [
        {
          step: 0,
          name: 'get_public_site_content',
          invalid: false,
          executed: false,
          status: 'not_executed',
        },
      ],
    })
  })

  it('keeps diagnostics while redacting raw outputs in summaries', () => {
    const diagnostics: AmaEvalGenerationDiagnostics = {
      finishReason: 'length',
      stepCount: 1,
      usage: {
        inputTokens: 12,
        outputTokens: 3,
      },
      totalUsage: {
        inputTokens: 12,
        outputTokens: 3,
      },
      stepFinishReasons: ['length'],
    }
    const summary: AmaEvalSummary = {
      modelConfig: { model: 'openai/test-model' },
      thresholds: {
        minOverallScore: 0.85,
        minCategoryScore: 0.75,
        maxCriticalFailures: 0,
      },
      generatedAt: '2026-05-10T00:00:00.000Z',
      totalCases: 1,
      passedCases: 0,
      failedCases: 1,
      weightedScore: 0,
      categoryScores: {
        style: 0,
      } as AmaEvalSummary['categoryScores'],
      criticalFailures: [
        {
          caseId: 'empty-output-test',
          score: 'output_presence',
          details: 'Output was empty.',
        },
      ],
      passed: false,
      results: [
        {
          id: 'empty-output-test',
          category: 'style',
          prompt: 'Tell me about Jonathan.',
          output: 'Sensitive raw output',
          redactedOutput: '[redacted]',
          toolCalls: [],
          diagnostics,
          scores: [
            {
              name: 'output_presence',
              score: 0,
              passed: false,
              critical: true,
              details: 'Output was empty.',
            },
          ],
          weightedScore: 0,
          passed: false,
          criticalFailures: ['output_presence'],
        },
      ],
    }

    const redactedSummary = getRedactedSummary(summary)

    expect(redactedSummary.results[0]?.output).toBe('[redacted]')
    expect(redactedSummary.results[0]?.redactedOutput).toBe('[redacted]')
    expect(redactedSummary.results[0]?.diagnostics).toEqual(diagnostics)

    const toolCase = amaEvalDataset.find((item) =>
      item.forbiddenSubstrings?.includes('get_resume'),
    )!
    const canary = sanitizedForbiddenTerms[0]!
    const toolCalls = ['get_resume', 'get_resume', canary]
    summary.results[0] = {
      ...summary.results[0]!,
      id: toolCase.id,
      redactedOutput: `get_resume ${canary}`,
      toolCalls,
      diagnostics: {
        ...diagnostics,
        toolSequence: toolCalls.map((name, step) => ({ step, name })),
      },
    }
    const reviewed = getRedactedSummary(summary).results[0]!
    expect(reviewed.output).toBe('[redacted] [redacted]')
    expect(reviewed.toolCalls).toEqual(['get_resume', 'get_resume', '[redacted]'])
    expect(reviewed.diagnostics?.toolSequence).toEqual([
      { step: 0, name: 'get_resume' },
      { step: 1, name: 'get_resume' },
      { step: 2, name: '[redacted]' },
    ])
  })

  it('restores only canonical outcome names while retaining private-field redaction and attempts', () => {
    const toolCase = amaEvalDataset.find((item) =>
      item.forbiddenSubstrings?.includes('get_resume'),
    )!
    const canary = sanitizedForbiddenTerms[0]!
    const names = [
      'get_public_site_content',
      'get_resume',
      'search_work_context',
      'search_personal_context',
      'get_resume',
      canary,
    ]
    // Extra properties and an arbitrary name simulate an untrusted diagnostic payload.
    const toolOutcomes = names.map((name, step) => ({
      step,
      name,
      invalid: step === 5,
      executed: step < 4,
      status: step === 5 ? 'not_executed' : 'found',
      error: canary,
      args: { query: canary },
      result: { content: canary },
    })) as unknown as AmaEvalGenerationDiagnostics['toolOutcomes']
    const summary: AmaEvalSummary = {
      modelConfig: { model: 'openai/test-model' },
      thresholds: { minOverallScore: 0.85, minCategoryScore: 0.75, maxCriticalFailures: 0 },
      generatedAt: '2026-09-06T00:00:00.000Z',
      totalCases: 1,
      passedCases: 0,
      failedCases: 1,
      weightedScore: 0,
      categoryScores: { style: 0 } as AmaEvalSummary['categoryScores'],
      criticalFailures: [],
      passed: false,
      results: [
        {
          id: toolCase.id,
          category: toolCase.category,
          prompt: canary,
          output: `get_resume ${canary}`,
          redactedOutput: `get_resume ${canary}`,
          toolCalls: names,
          diagnostics: { stepCount: 6, stepFinishReasons: [], toolOutcomes, errorKind: canary },
          scores: [],
          weightedScore: 0,
          passed: false,
          criticalFailures: [],
        },
      ],
    }

    const redacted = getRedactedSummary(summary)
    const reviewed = redacted.results[0]!

    expect(reviewed.diagnostics?.toolOutcomes).toEqual(
      names.map((name, step) => ({
        step,
        name: step === 5 ? '[redacted]' : name,
        invalid: step === 5,
        executed: step < 4,
        status: step === 5 ? 'not_executed' : 'found',
        error: '[redacted]',
        args: { query: '[redacted]' },
        result: { content: '[redacted]' },
      })),
    )
    expect(reviewed.toolCalls).toEqual([...names.slice(0, 5), '[redacted]'])
    expect(reviewed.output).toBe('[redacted] [redacted]')
    expect(reviewed.prompt).toBe('[redacted]')
    expect(reviewed.diagnostics?.errorKind).toBe('[redacted]')
    expect(JSON.stringify(redacted)).not.toContain(canary)
    expect(summary.results[0]?.diagnostics?.toolOutcomes?.[5]?.name).toBe(canary)
  })
})
