import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { amaEvalDataset } from './dataset'
import { sha256 } from './hashes'
import {
  assertFrozenFinalSuite,
  FINAL_RELEASE_DATASET_SHA256,
  finalReleaseDataset,
} from './release'
import { SELECTION_DATASET_SHA256 } from './run'

export function buildTrainingEvalManifests() {
  assertFrozenFinalSuite()
  const cases = [...amaEvalDataset, ...finalReleaseDataset]
  const identity = {
    selection_dataset_sha256: SELECTION_DATASET_SHA256,
    final_dataset_sha256: FINAL_RELEASE_DATASET_SHA256,
  }
  const manifest = {
    schema_version: 1,
    dataset_sha256: sha256(identity),
    ...identity,
    question_sha256: [
      ...new Set(
        cases
          .flatMap((item) => [
            item.prompt,
            ...(item.priorMessages ?? [])
              .filter((message) => message.role === 'user')
              .map((message) => message.content),
          ])
          .map((question) =>
            sha256(question.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()),
          ),
      ),
    ].sort(),
    family_ids: cases.map((item) => `eval:${item.id}`).sort(),
  }
  const policy = {
    schema_version: 1,
    kind: 'ama_release_policy',
    ...identity,
    selection_case_ids: amaEvalDataset.map((item) => item.id),
    final_case_ids: finalReleaseDataset.map((item) => item.id),
    selection_judge_case_ids: amaEvalDataset.filter((item) => item.judge).map((item) => item.id),
    final_judge_case_ids: finalReleaseDataset.filter((item) => item.judge).map((item) => item.id),
    selection_case_categories: Object.fromEntries(
      amaEvalDataset.map((item) => [item.id, item.category]),
    ),
    final_case_categories: Object.fromEntries(
      finalReleaseDataset.map((item) => [item.id, item.category]),
    ),
    min_selection_score: 0.85,
    min_final_score: 0.85,
    min_category_score: 0.75,
    max_critical_failures: 0,
  }
  return { manifest, policy: { ...policy, artifact_sha256: sha256(policy) } }
}

export async function exportTrainingEvalManifests() {
  const { manifest, policy } = buildTrainingEvalManifests()
  const output = resolve(process.env.AMA_EVAL_MANIFEST_DIR?.trim() || 'evals/ama/results')
  await mkdir(output, { recursive: true })
  await writeFile(
    resolve(output, 'training-eval-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  await writeFile(resolve(output, 'release-policy.json'), `${JSON.stringify(policy, null, 2)}\n`)
  console.log(`Evaluation fingerprints and release policy: ${output}`)
}
