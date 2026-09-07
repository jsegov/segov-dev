import { AmaModelConfigurationError } from '@/lib/ama-model-config'

/** Require an intentional subject model in CI before any generation or judging. */
export function assertExplicitCiModelConfig(): void {
  if (process.env.AMA_EVAL_CI !== '1') {
    return
  }

  const model = process.env.AMA_CHAT_MODEL?.trim()
  const inferenceBaseUrl = process.env.AMA_INFERENCE_BASE_URL?.trim()
  const deploymentModel = process.env.AMA_DEPLOYMENT_MODEL?.trim()

  if (inferenceBaseUrl || deploymentModel) {
    if (!inferenceBaseUrl || !deploymentModel) {
      throw new AmaModelConfigurationError(
        'AMA CI evaluations require both AMA_INFERENCE_BASE_URL and AMA_DEPLOYMENT_MODEL when either is configured.',
      )
    }
    return
  }

  if (!model) {
    throw new AmaModelConfigurationError(
      'AMA CI evaluations require an explicit AMA_CHAT_MODEL or both AMA_INFERENCE_BASE_URL and AMA_DEPLOYMENT_MODEL; runtime model defaults are not used in CI.',
    )
  }
}
