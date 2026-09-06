import { z } from 'zod'
import type { AmaModelConfig } from '@/lib/ama-model-config'
import type { AmaEvalSummary } from './types'
import type { readEvidenceBindings } from './evidence'
import { sha256 } from './hashes'

const decisionSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('ama_selection_decision'),
  artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  policy: z.object({
    selection_dataset_sha256: z.string(),
    final_dataset_sha256: z.string(),
  }),
  winner: z.object({
    candidate_id: z.string(),
    checkpoint_path: z.string(),
    model_artifact_sha256: z.string(),
    serving_config_sha256: z.string(),
    evaluation_configuration: z.record(z.string(), z.unknown()),
    serving: z.object({
      endpoint: z.string(),
      model: z.string(),
      config: z.object({
        call_settings: z.record(z.string(), z.unknown()),
        reasoning_effort: z.union([z.string(), z.number()]).nullish(),
      }),
    }),
  }),
})

/** Verify the actual sealed checkpoint decision before executing final cases. */
export function verifyCheckpointDecision(
  value: unknown,
  modelConfig: AmaModelConfig,
  metadata: NonNullable<AmaEvalSummary['metadata']>,
  bindings: ReturnType<typeof readEvidenceBindings>,
): void {
  const decision = decisionSchema.parse(value)
  const { artifact_sha256, ...payload } = value as Record<string, unknown>
  const winner = decision.winner
  const config = winner.evaluation_configuration
  const keys = [
    'promptSha256',
    'promptManifestSha256',
    'scorerSha256',
    'transportSha256',
    'sdkVersion',
    'judgeModelConfig',
    'judgeCallSettings',
  ] as const
  if (
    sha256(payload) !== artifact_sha256 ||
    bindings.selection_decision_sha256 !== decision.artifact_sha256 ||
    bindings.candidate_id !== winner.candidate_id ||
    bindings.checkpoint_path !== winner.checkpoint_path ||
    bindings.model_artifact_sha256 !== winner.model_artifact_sha256 ||
    bindings.serving_config_sha256 !== winner.serving_config_sha256 ||
    decision.policy.selection_dataset_sha256 !== metadata.selectionDatasetSha256 ||
    decision.policy.final_dataset_sha256 !== metadata.finalDatasetSha256 ||
    keys.some((key) => config[key] == null || sha256(config[key]) !== sha256(metadata[key])) ||
    sha256(winner.serving.config.call_settings) !== sha256(metadata.callSettings) ||
    winner.serving.model !== modelConfig.model ||
    winner.serving.endpoint !== modelConfig.inference?.baseURL.replace(/\/$/, '') ||
    (winner.serving.config.reasoning_effort ?? null) !==
      (modelConfig.providerOptions?.inference?.reasoning_effort ?? null)
  ) {
    throw new Error('Final evaluation configuration does not match the frozen checkpoint decision.')
  }
}
