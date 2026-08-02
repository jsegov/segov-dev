import { createHash } from 'node:crypto'
import { personalFallbacksEvalCases } from './cases/personal-fallbacks'
import { publicResumeEvalCases } from './cases/public-resume'
import { scopeEvalCases } from './cases/scope'
import { workPrivacyEvalCases } from './cases/work-privacy'
import type { AmaEvalCase } from './types'

export const amaEvalDataset: AmaEvalCase[] = [
  ...scopeEvalCases,
  ...publicResumeEvalCases,
  ...workPrivacyEvalCases,
  ...personalFallbacksEvalCases,
]

// Content hash of the frozen suite. Training-data generation and eval
// decontamination key off this version; the pinned value in
// tests/evals/ama-dataset.test.ts makes any dataset edit an explicit,
// reviewable unfreeze.
export const AMA_EVAL_DATASET_VERSION = createHash('sha256')
  .update(JSON.stringify(amaEvalDataset))
  .digest('hex')
