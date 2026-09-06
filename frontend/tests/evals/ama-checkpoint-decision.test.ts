// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAmaEvalSuite } from '../../evals/ama/run'
import type * as StreamModule from '../../evals/ama/stream'
import { generatePublicEvalCase } from '../../evals/ama/stream'

vi.mock('../../evals/ama/stream', async (original) => ({
  ...(await original<typeof StreamModule>()),
  generatePublicEvalCase: vi.fn(),
}))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})
import { verifyCheckpointDecision } from '../../evals/ama/checkpoint-decision'
import { sha256 } from '../../evals/ama/hashes'
import type { AmaEvalSummary } from '../../evals/ama/types'

function fixture() {
  const config = {
    promptSha256: 'prompt',
    promptManifestSha256: 'manifest',
    scorerSha256: 'scorer',
    transportSha256: 'transport',
    sdkVersion: 'sdk',
    judgeModelConfig: { model: 'judge' },
    judgeCallSettings: { maxOutputTokens: 100 },
  }
  const callSettings = { maxOutputTokens: 1536, temperature: 0 }
  const metadata = {
    ...config,
    callSettings,
    selectionDatasetSha256: 'selection',
    finalDatasetSha256: 'final',
  } as unknown as NonNullable<AmaEvalSummary['metadata']>
  const model = { model: 'candidate', inference: { baseURL: 'https://example.com/v1' } }
  const winner = {
    candidate_id: 'candidate',
    checkpoint_path: 'checkpoint',
    model_artifact_sha256: 'a'.repeat(64),
    serving_config_sha256: 'b'.repeat(64),
    evaluation_configuration: config,
    serving: {
      endpoint: model.inference.baseURL,
      model: model.model,
      config: { call_settings: callSettings },
    },
  }
  const payload = {
    schema_version: 1,
    kind: 'ama_selection_decision',
    policy: { selection_dataset_sha256: 'selection', final_dataset_sha256: 'final' },
    winner,
  }
  const decision = { ...payload, artifact_sha256: sha256(payload) }
  const bindings = {
    candidate_id: winner.candidate_id,
    checkpoint_path: winner.checkpoint_path,
    model_artifact_sha256: winner.model_artifact_sha256,
    serving_config_sha256: winner.serving_config_sha256,
    selection_decision_sha256: decision.artifact_sha256,
    final_attempt_id: 'attempt',
  }
  return { decision, model, metadata, bindings }
}

describe('frozen checkpoint final configuration', () => {
  it('accepts the exact sealed checkpoint and effective runtime configuration', () => {
    const f = fixture()
    expect(() =>
      verifyCheckpointDecision(f.decision, f.model, f.metadata, f.bindings),
    ).not.toThrow()
  })

  it.each([
    'promptSha256',
    'promptManifestSha256',
    'scorerSha256',
    'transportSha256',
    'sdkVersion',
    'judgeModelConfig',
    'judgeCallSettings',
    'callSettings',
    'selectionDatasetSha256',
    'finalDatasetSha256',
  ])('rejects changed %s before final execution', (key) => {
    const f = fixture()
    expect(() =>
      verifyCheckpointDecision(
        f.decision,
        f.model,
        { ...f.metadata, [key]: 'changed' },
        f.bindings,
      ),
    ).toThrow('does not match')
  })

  it.each([
    'candidate_id',
    'checkpoint_path',
    'model_artifact_sha256',
    'serving_config_sha256',
    'selection_decision_sha256',
  ])('rejects mismatched %s', (key) => {
    const f = fixture()
    expect(() =>
      verifyCheckpointDecision(f.decision, f.model, f.metadata, {
        ...f.bindings,
        [key]: 'changed',
      }),
    ).toThrow('does not match')
  })

  it('rejects mutated decisions, endpoint/model/effort drift, and malformed artifacts', () => {
    const f = fixture()
    for (const model of [
      { ...f.model, model: 'other' },
      { ...f.model, inference: { baseURL: 'https://other.example/v1' } },
      { ...f.model, providerOptions: { inference: { reasoning_effort: 'high' } } },
    ]) {
      expect(() => verifyCheckpointDecision(f.decision, model, f.metadata, f.bindings)).toThrow(
        'does not match',
      )
    }
    f.decision.winner.candidate_id = 'tampered'
    expect(() => verifyCheckpointDecision(f.decision, f.model, f.metadata, f.bindings)).toThrow(
      'does not match',
    )
    for (const value of [null, {}, 'hash-only']) {
      expect(() => verifyCheckpointDecision(value, f.model, f.metadata, f.bindings)).toThrow()
    }
  })
})

it('refuses hash-only final runs and checks sealed configuration before generation', async () => {
  const f = fixture()
  vi.stubEnv('AMA_EVAL_REQUIRE_BINDINGS', '')
  vi.stubEnv('AMA_EVAL_CANDIDATE_ID', '')
  vi.stubEnv('AMA_EVAL_SELECTION_REPORT', '')
  vi.stubEnv('AMA_EVAL_CHECKPOINT_DECISION', '')
  vi.stubEnv('AMA_EVAL_SELECTION_DECISION_SHA256', f.decision.artifact_sha256)
  await expect(
    runAmaEvalSuite({ partition: 'final', profile: 'production', useJudge: false }),
  ).rejects.toThrow('frozen selection')
  const dir = await mkdtemp(join(tmpdir(), 'ama-final-guard-'))
  try {
    const file = join(dir, 'decision.json')
    await writeFile(file, JSON.stringify(f.decision))
    vi.stubEnv('AMA_EVAL_CHECKPOINT_DECISION', file)
    vi.stubEnv('AMA_EVAL_CANDIDATE_ID', f.bindings.candidate_id)
    vi.stubEnv('AMA_EVAL_CHECKPOINT_PATH', f.bindings.checkpoint_path)
    vi.stubEnv('AMA_EVAL_MODEL_ARTIFACT_SHA256', f.bindings.model_artifact_sha256)
    vi.stubEnv('AMA_EVAL_SERVING_CONFIG_SHA256', f.bindings.serving_config_sha256)
    vi.stubEnv('AMA_EVAL_FINAL_ATTEMPT_ID', '12345678-1234-1234-1234-123456789abc')
    await expect(
      runAmaEvalSuite({ partition: 'final', profile: 'production', useJudge: false }),
    ).rejects.toThrow('does not match')
    expect(generatePublicEvalCase).not.toHaveBeenCalled()
  } finally {
    await rm(dir, { recursive: true })
  }
})
