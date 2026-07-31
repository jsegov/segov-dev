import { describe, expect, it } from 'vitest'
import { OUT_OF_SCOPE_MESSAGE } from '@/lib/ama-agent'
import { AMA_EVAL_DATASET_VERSION, amaEvalDataset } from '@/evals/ama/dataset'

// The suite froze on 2026-07-30 after a clean live teacher run (150/150,
// overall 1.000, zero failures). Any edit to the dataset changes this
// hash: update the pin ONLY as a deliberate unfreeze, and never after training
// question generation has started without regenerating decontamination.
const FROZEN_DATASET_VERSION = '2038c9f61c45f9a5e69a7e5cf970a874232e12fbe93adf639736ccf05512b5e6'

const VALID_TOOLS = [
  'get_public_site_content',
  'get_resume',
  'search_work_context',
  'search_personal_context',
]

describe('AMA eval dataset invariants', () => {
  it('has the expanded frozen size', () => {
    expect(amaEvalDataset.length).toBeGreaterThanOrEqual(140)
    expect(amaEvalDataset.length).toBeLessThanOrEqual(200)
  })

  it('matches the frozen dataset version', () => {
    expect(AMA_EVAL_DATASET_VERSION).toBe(FROZEN_DATASET_VERSION)
  })

  it('uses unique case ids', () => {
    const ids = amaEvalDataset.map((evalCase) => evalCase.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('asserts first-person voice on every case', () => {
    const missing = amaEvalDataset.filter((evalCase) => evalCase.expectFirstPerson !== true)
    expect(missing.map((evalCase) => evalCase.id)).toEqual([])
  })

  it('only references valid tool names with disjoint expectations', () => {
    for (const evalCase of amaEvalDataset) {
      const expected = evalCase.expectedTools ?? []
      const disallowed = evalCase.disallowedTools ?? []
      for (const toolName of [...expected, ...disallowed]) {
        expect(VALID_TOOLS, `${evalCase.id} references unknown tool ${toolName}`).toContain(
          toolName,
        )
      }
      const overlap = expected.filter((toolName) => disallowed.includes(toolName))
      expect(overlap, `${evalCase.id} expects and disallows the same tool`).toEqual([])
    }
  })

  it('treats leakage as critical wherever forbidden terms are asserted', () => {
    for (const evalCase of amaEvalDataset) {
      if ((evalCase.forbiddenSubstrings ?? []).length > 0) {
        expect(
          evalCase.criticalScores ?? [],
          `${evalCase.id} has forbidden substrings but forbidden_leakage is not critical`,
        ).toContain('forbidden_leakage')
      }
    }
  })

  it('marks exact refusals critical and tool-free', () => {
    for (const evalCase of amaEvalDataset) {
      if (evalCase.expectedExact === OUT_OF_SCOPE_MESSAGE) {
        expect(
          evalCase.criticalScores ?? [],
          `${evalCase.id} refusal must make exact_match critical`,
        ).toContain('exact_match')
        expect(
          evalCase.disallowedTools ?? [],
          `${evalCase.id} refusal must disallow all tools`,
        ).toEqual(expect.arrayContaining(VALID_TOOLS))
      }
    }
  })

  it('scripts prior messages as alternating user/assistant turns ending with assistant', () => {
    for (const evalCase of amaEvalDataset) {
      const priorMessages = evalCase.priorMessages ?? []
      if (priorMessages.length === 0) {
        continue
      }

      expect(priorMessages[0]?.role, `${evalCase.id} priorMessages must start with user`).toBe(
        'user',
      )
      expect(
        priorMessages[priorMessages.length - 1]?.role,
        `${evalCase.id} priorMessages must end with assistant (prompt is the final user turn)`,
      ).toBe('assistant')
      for (let index = 1; index < priorMessages.length; index++) {
        expect(
          priorMessages[index]?.role,
          `${evalCase.id} priorMessages must alternate roles`,
        ).not.toBe(priorMessages[index - 1]?.role)
      }
      for (const priorMessage of priorMessages) {
        expect(
          priorMessage.content.trim().length,
          `${evalCase.id} has an empty prior message`,
        ).toBeGreaterThan(0)
      }
    }
  })

  it('covers every category with a meaningful share of cases', () => {
    const counts = new Map<string, number>()
    for (const evalCase of amaEvalDataset) {
      counts.set(evalCase.category, (counts.get(evalCase.category) ?? 0) + 1)
    }

    for (const category of [
      'scope',
      'public_content',
      'resume',
      'work_privacy',
      'personal_projects',
      'fallbacks',
      'style',
      'conversation',
    ]) {
      expect(
        counts.get(category) ?? 0,
        `category ${category} is under-covered`,
      ).toBeGreaterThanOrEqual(4)
    }
  })
})
