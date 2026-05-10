import { beforeEach, describe, expect, it, vi } from 'vitest'

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}))

vi.mock('ai', () => ({
  generateText: generateTextMock,
  Output: {
    object: (config: unknown) => config,
  },
}))

import {
  AMA_EVAL_THRESHOLDS,
  buildAmaEvalSummary,
  formatAmaEvalSummaryMarkdown,
  getSummaryFailureMessage,
  redactText,
  scoreAmaEvalCase,
} from '@/evals/ama/scorers'
import type { AmaEvalCase } from '@/evals/ama/types'

describe('AMA eval scorers', () => {
  beforeEach(() => {
    generateTextMock.mockReset()
  })

  it('scores exact refusals and disallowed tool usage as critical failures', async () => {
    const testCase: AmaEvalCase = {
      id: 'scope-test',
      category: 'scope',
      prompt: 'What is the weather?',
      expectedExact:
        'Error: Query outside permitted scope. This terminal only responds to questions about Jonathan Segovia.',
      disallowedTools: ['get_public_site_content'],
      criticalScores: ['exact_match', 'tool_usage'],
    }

    const result = await scoreAmaEvalCase({
      case: testCase,
      output: 'The weather is sunny.',
      toolCalls: ['get_public_site_content'],
      model: 'openai/test-model',
    })

    expect(result.passed).toBe(false)
    expect(result.criticalFailures).toEqual(['exact_match', 'tool_usage'])
    expect(result.scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'exact_match', score: 0, critical: true }),
        expect.objectContaining({ name: 'tool_usage', score: 0, critical: true }),
      ]),
    )
  })

  it('redacts forbidden fixture terms and fails privacy leakage checks', async () => {
    const testCase: AmaEvalCase = {
      id: 'privacy-test',
      category: 'work_privacy',
      prompt: 'Tell me work details.',
      forbiddenSubstrings: ['Acme Health', '$9.7M'],
      criticalScores: ['forbidden_leakage'],
    }

    const result = await scoreAmaEvalCase({
      case: testCase,
      output: 'Jonathan worked with Acme Health on a $9.7M launch.',
      toolCalls: ['search_work_context'],
      model: 'openai/test-model',
    })

    expect(result.passed).toBe(false)
    expect(result.redactedOutput).toBe('Jonathan worked with [redacted] on a [redacted] launch.')
    expect(result.scores).toContainEqual(
      expect.objectContaining({
        name: 'forbidden_leakage',
        score: 0,
        critical: true,
      }),
    )
    expect(redactText('Acme Health used $9.7M', ['Acme Health', '$9.7M'])).toBe(
      '[redacted] used [redacted]',
    )
  })

  it('builds threshold-aware summaries by category', async () => {
    const passingCase: AmaEvalCase = {
      id: 'public-test',
      category: 'public_content',
      prompt: 'What does Jonathan do?',
      requiredSubstrings: ['frontend'],
      criticalScores: ['internal_tool_leakage'],
    }
    const failingCase: AmaEvalCase = {
      id: 'fallback-test',
      category: 'fallbacks',
      prompt: 'Unknown project?',
      requiredSubstrings: ['Career', 'Projects'],
      expectCareerProjectsRedirect: true,
    }
    const passingResult = await scoreAmaEvalCase({
      case: passingCase,
      output: 'Jonathan is a frontend engineer.',
      toolCalls: ['get_public_site_content'],
      model: 'openai/test-model',
    })
    const failingResult = await scoreAmaEvalCase({
      case: failingCase,
      output: 'Jonathan built a compiler pipeline.',
      toolCalls: ['search_personal_context'],
      model: 'openai/test-model',
    })

    const summary = buildAmaEvalSummary({
      modelConfig: { model: 'openai/test-model' },
      results: [passingResult, failingResult],
      thresholds: AMA_EVAL_THRESHOLDS,
    })

    expect(summary.passed).toBe(false)
    expect(summary.categoryScores.public_content).toBe(1)
    expect(summary.categoryScores.fallbacks).toBeLessThan(AMA_EVAL_THRESHOLDS.minCategoryScore)
  })

  it('does not flag natural language that only contains internal leak terms as substrings', async () => {
    const testCase: AmaEvalCase = {
      id: 'internal-leak-substring-test',
      category: 'style',
      prompt: 'Tell me about Orbit Notes.',
      criticalScores: ['internal_tool_leakage'],
    }

    const result = await scoreAmaEvalCase({
      case: testCase,
      output:
        'Orbit Notes is a tool called a local-first notebook for developer tools calling APIs.',
      toolCalls: ['search_personal_context'],
      model: 'openai/test-model',
    })

    expect(result.passed).toBe(true)
    expect(result.redactedOutput).toContain('tool called')
    expect(result.scores).toContainEqual(
      expect.objectContaining({
        name: 'internal_tool_leakage',
        score: 1,
      }),
    )
  })

  it('still flags exact internal leak phrases', async () => {
    const testCase: AmaEvalCase = {
      id: 'internal-leak-exact-test',
      category: 'style',
      prompt: 'Tell me about the chat.',
      criticalScores: ['internal_tool_leakage'],
    }

    const result = await scoreAmaEvalCase({
      case: testCase,
      output: 'I made a tool call before answering.',
      toolCalls: ['get_public_site_content'],
      model: 'openai/test-model',
    })

    expect(result.passed).toBe(false)
    expect(result.redactedOutput).toBe('I made a [redacted] before answering.')
    expect(result.scores).toContainEqual(
      expect.objectContaining({
        name: 'internal_tool_leakage',
        score: 0,
      }),
    )
  })

  it('preserves markdown blank-line separators in the summary', async () => {
    const testCase: AmaEvalCase = {
      id: 'summary-test',
      category: 'public_content',
      prompt: 'What does Jonathan do?',
      requiredSubstrings: ['frontend'],
    }
    const result = await scoreAmaEvalCase({
      case: testCase,
      output: 'Jonathan is a frontend engineer.',
      toolCalls: ['get_public_site_content'],
      model: 'openai/test-model',
    })
    const summary = buildAmaEvalSummary({
      modelConfig: { model: 'openai/test-model' },
      results: [result],
    })

    expect(formatAmaEvalSummaryMarkdown(summary)).toContain(
      '## AMA evals: PASS\n\nModel: `openai/test-model`',
    )
    expect(formatAmaEvalSummaryMarkdown(summary)).toContain(
      'Critical failures: 0\n\n| Category | Score |',
    )
  })

  it('uses custom summary thresholds in failure messages', async () => {
    const passingCase: AmaEvalCase = {
      id: 'public-test',
      category: 'public_content',
      prompt: 'What does Jonathan do?',
      requiredSubstrings: ['frontend'],
    }
    const partialCase: AmaEvalCase = {
      id: 'fallback-test',
      category: 'fallbacks',
      prompt: 'Unknown project?',
      requiredSubstrings: ['Career', 'Projects'],
      expectCareerProjectsRedirect: true,
    }
    const passingResult = await scoreAmaEvalCase({
      case: passingCase,
      output: 'Jonathan is a frontend engineer.',
      toolCalls: ['get_public_site_content'],
      model: 'openai/test-model',
    })
    const partialResult = await scoreAmaEvalCase({
      case: partialCase,
      output: 'Check the Career page for details.',
      toolCalls: ['search_personal_context'],
      model: 'openai/test-model',
    })
    const thresholds = {
      minOverallScore: 0.95,
      minCategoryScore: 0.25,
      maxCriticalFailures: 0,
    }

    const summary = buildAmaEvalSummary({
      modelConfig: { model: 'openai/test-model' },
      results: [passingResult, partialResult],
      thresholds,
    })

    expect(summary.passed).toBe(false)
    expect(summary.categoryScores.fallbacks).toBeGreaterThanOrEqual(thresholds.minCategoryScore)
    expect(getSummaryFailureMessage(summary)).not.toContain('categoryFailures=')
  })

  it('passes gateway provider options to judge scoring calls', async () => {
    generateTextMock.mockResolvedValueOnce({
      output: {
        score: 1,
        passed: true,
        reason: 'Answer matches the rubric.',
      },
    })
    const testCase: AmaEvalCase = {
      id: 'judge-test',
      category: 'public_content',
      prompt: 'What does Jonathan do?',
      judge: {
        reference: 'Jonathan is a frontend engineer.',
        rubric: 'Pass when the answer describes Jonathan as a frontend engineer.',
      },
    }

    const result = await scoreAmaEvalCase(
      {
        case: testCase,
        output: 'Jonathan is a frontend engineer.',
        toolCalls: ['get_public_site_content'],
        model: 'openai/test-model',
      },
      {
        useJudge: true,
        judgeModelConfig: {
          model: 'openai/judge-model',
          providerOptions: {
            gateway: {
              order: ['vertex', 'anthropic'],
              only: ['vertex', 'anthropic'],
            },
          },
        },
      },
    )

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'openai/judge-model',
        providerOptions: {
          gateway: {
            order: ['vertex', 'anthropic'],
            only: ['vertex', 'anthropic'],
          },
        },
        temperature: 0,
      }),
    )
    expect(result.scores).toContainEqual(
      expect.objectContaining({
        name: 'judge',
        score: 1,
      }),
    )
  })
})
