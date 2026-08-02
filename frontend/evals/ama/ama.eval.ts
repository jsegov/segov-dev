import { describe, expect, it } from 'vitest'
import { runAmaEvalSuite } from './run'

const hasGatewayAuth = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN)
const hasInferenceEndpoint = Boolean(process.env.AMA_INFERENCE_BASE_URL?.trim())
const isCiGate = process.env.AMA_EVAL_CI === '1'

describe('AMA live evals', () => {
  it('passes the AMA quality gate', async () => {
    if (!hasGatewayAuth && !hasInferenceEndpoint) {
      if (isCiGate) {
        throw new Error(
          'AMA live evals require AI_GATEWAY_API_KEY, VERCEL_OIDC_TOKEN, or AMA_INFERENCE_BASE_URL.',
        )
      }

      console.warn('Skipping AMA live evals because no model credentials are configured.')
      return
    }

    const summary = await runAmaEvalSuite()

    expect(summary.totalCases).toBeGreaterThan(0)
    if (isCiGate) {
      expect(summary.passed).toBe(true)
    }
  }, 1500000)
})
