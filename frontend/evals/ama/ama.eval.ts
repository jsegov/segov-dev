import { describe, expect, it } from 'vitest'
import { runAmaEvalSuite } from './run'
import { runBudgetMatrix, selectSavedBudgetMatrix } from './matrix'
import { exportTrainingEvalManifests } from './training-manifest'

const hasGatewayAuth = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN)
const hasInferenceEndpoint = Boolean(process.env.AMA_INFERENCE_BASE_URL?.trim())
const isCiGate = process.env.AMA_EVAL_CI === '1'

describe('AMA live evals', () => {
  it(
    'passes the AMA quality gate',
    async () => {
      const command = process.env.AMA_EVAL_COMMAND ?? 'suite'
      if (command === 'select') {
        const report = await selectSavedBudgetMatrix()
        expect(report.passed).toBe(true)
        return
      }
      if (command === 'export-manifest') {
        await exportTrainingEvalManifests()
        return
      }
      if (command !== 'suite' && command !== 'matrix') {
        throw new Error('AMA_EVAL_COMMAND must be suite, matrix, select, or export-manifest.')
      }
      if (!hasGatewayAuth && !hasInferenceEndpoint) {
        if (isCiGate || command === 'matrix' || process.env.AMA_EVAL_SUITE === 'final') {
          throw new Error(
            'AMA live evals require AI_GATEWAY_API_KEY, VERCEL_OIDC_TOKEN, or AMA_INFERENCE_BASE_URL.',
          )
        }

        console.warn('Skipping AMA live evals because no model credentials are configured.')
        return
      }

      if (command === 'matrix') {
        const report = await runBudgetMatrix()
        expect(report.passed).toBe(true)
        return
      }
      const summary = await runAmaEvalSuite()

      expect(summary.totalCases).toBeGreaterThan(0)
      if (isCiGate || process.env.AMA_EVAL_SUITE === 'final') {
        expect(summary.passed).toBe(true)
      }
    },
    12 * 60 * 60 * 1000,
  )
})
