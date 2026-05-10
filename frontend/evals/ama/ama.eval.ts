import { describe, expect, it } from 'vitest'
import { runAmaEvalSuite } from './run'

const hasGatewayAuth = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN)
const isCiGate = process.env.AMA_EVAL_CI === '1'

describe('AMA live evals', () => {
  it('passes the AMA quality gate', async () => {
    if (!hasGatewayAuth) {
      if (isCiGate) {
        throw new Error('AMA live evals require AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN.')
      }

      console.warn('Skipping AMA live evals because no AI Gateway auth is configured.')
      return
    }

    const summary = await runAmaEvalSuite({ enforceThresholds: isCiGate })
    expect(summary.passed || !isCiGate).toBe(true)
  }, 180000)
})
