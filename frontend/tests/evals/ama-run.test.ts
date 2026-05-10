import { describe, expect, it } from 'vitest'
import { mapWithConcurrency, parsePositiveIntegerEnv } from '@/evals/ama/run'

describe('AMA eval runner helpers', () => {
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
})
