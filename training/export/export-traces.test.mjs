import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDataset, digest, questionHash, resolveRows, writeSnapshot } from './export-traces.mjs'

const prompt = (version) => ({
  version,
  instructions: 'Synthetic assistant.',
  tool_declarations: [],
  call_settings: {},
})
const row = (id, extra = {}) => ({
  id,
  conversation_id: `synth-${id}`,
  turn: 1,
  system_prompt_version: 'v1',
  model: 'teacher',
  response_model: 'teacher-version',
  finish_reason: 'stop',
  input_messages: [{ role: 'user', content: `question ${id}` }],
  response_messages: [{ role: 'assistant', content: 'Synthetic answer.' }],
  created_at: '2026-01-01T00:00:00Z',
  ...extra,
})
const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
const write = (file, value) => writeFileSync(file, JSON.stringify(value))
function setup(rows, prompts = { v1: prompt('v1'), v2: prompt('v2') }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ama-export-')),
    snapshotDir = path.join(dir, 'snapshot')
  writeSnapshot(rows, prompts, snapshotDir)
  const reviewsPath = path.join(dir, 'reviews.json'),
    policyPath = path.join(dir, 'policy.json'),
    fingerprintsPath = path.join(dir, 'fingerprints.json')
  const reviews = read(path.join(snapshotDir, 'review-manifest.template.json'))
  for (const [id, review] of Object.entries(reviews.rows))
    Object.assign(review, {
      decision: 'approved',
      family_id: `family-${id}`,
      reason: 'Reviewed entire synthetic input and output; no private content.',
    })
  const fingerprints = {
    schema_version: 1,
    dataset_sha256: 'eval-suite',
    selection_dataset_sha256: 'selection-suite',
    final_dataset_sha256: 'final-suite',
    question_sha256: [],
    family_ids: [],
  }
  const policy = {
    schema_version: 1,
    corpus_class: 'synthetic',
    allowed_models: ['teacher'],
    allowed_response_models: ['teacher-version'],
    allowed_prompt_versions: ['v1', 'v2'],
    conversation_prefixes: ['synth-'],
    evaluation_fingerprints_sha256: digest(fingerprints),
  }
  write(reviewsPath, reviews)
  write(policyPath, policy)
  write(fingerprintsPath, fingerprints)
  return {
    dir,
    reviews,
    policy,
    fingerprints,
    snapshotDir,
    reviewsPath,
    policyPath,
    fingerprintsPath,
    outDir: path.join(dir, 'dataset'),
  }
}

test('offline build is deterministic and carries complete review lineage', () => {
  const config = setup([row('1'), row('2')])
  const a = buildDataset(config)
  const b = buildDataset({ ...config, outDir: path.join(config.dir, 'dataset2') })
  assert.equal(a.artifact_sha256, b.artifact_sha256)
  assert.ok(a.files['source-traces.jsonl'])
  assert.throws(() => buildDataset(config), /already exists/)
})
test('snapshot retains database Date values and binds them to approval hashes', () => {
  const config = setup([row('dated', { created_at: new Date('2026-01-02T03:04:05Z') })])
  const saved = JSON.parse(
    readFileSync(path.join(config.snapshotDir, 'traces.jsonl'), 'utf8').trim(),
  )
  assert.equal(saved.created_at, '2026-01-02T03:04:05.000Z')
  assert.equal(config.reviews.rows.dated.row_sha256, digest(saved))
  assert.notEqual(digest(new Date('2026-01-01')), digest(new Date('2026-01-02')))
  buildDataset(config)
})
test('pending, wrong teacher, visitor, non-stop, and evaluation-family rows are excluded', () => {
  const config = setup([
    row('good'),
    row('pending'),
    row('rejected'),
    row('model', { response_model: 'student' }),
    row('visitor', { conversation_id: 'visitor-1' }),
    row('length', { finish_reason: 'length' }),
    row('eval'),
  ])
  config.reviews.rows.pending.decision = 'pending'
  config.reviews.rows.rejected.decision = 'rejected'
  config.fingerprints.family_ids = ['family-eval']
  config.policy.evaluation_fingerprints_sha256 = digest(config.fingerprints)
  write(config.reviewsPath, config.reviews)
  write(config.policyPath, config.policy)
  write(config.fingerprintsPath, config.fingerprints)
  buildDataset(config)
  const report = read(path.join(config.outDir, 'export-report.json'))
  assert.equal(report.qwen_examples, 1)
  assert.equal(report.snapshot_rows, report.qwen_examples + report.excluded_rows)
  assert.deepEqual(report.exclusion_counts, {
    pending: 1,
    rejected: 1,
    changed: 0,
    non_synthetic: 1,
    teacher_model: 1,
    prompt_version: 0,
    unsupported_tool_availability_policy: 0,
    non_stop: 1,
    evaluation_contamination: 1,
    superseded_branch: 0,
  })
})
test('legacy static prompt manifests remain unchanged', () => {
  const config = setup([row('static')])
  buildDataset(config)
  assert.equal(
    readFileSync(path.join(config.outDir, 'prompt-manifest.json'), 'utf8'),
    readFileSync(path.join(config.snapshotDir, 'prompt-manifest.json'), 'utf8'),
  )
})
for (const policy of ['single-use-context-v1', 'future-policy', 'static', null, '', false]) {
  test(`approved tool availability policy ${JSON.stringify(policy)} is excluded and separated from call settings`, () => {
    const config = setup([row('static'), row('dynamic', { system_prompt_version: 'v2' })], {
      v1: prompt('v1'),
      v2: {
        ...prompt('v2'),
        call_settings: { temperature: 0, maxOutputTokens: 1024, toolAvailabilityPolicy: policy },
      },
    })
    buildDataset(config)
    const report = read(path.join(config.outDir, 'export-report.json'))
    assert.equal(report.exclusion_counts.unsupported_tool_availability_policy, 1)
    assert.deepEqual(report.excluded, [
      { trace_id: 'dynamic', reason: 'unsupported_tool_availability_policy' },
    ])
    assert.equal(report.qwen_examples, 1)
    const prompts = read(path.join(config.outDir, 'prompt-manifest.json'))
    assert.equal(prompts.v2.toolAvailabilityPolicy, policy)
    assert.deepEqual(prompts.v2.call_settings, { temperature: 0, maxOutputTokens: 1024 })
    assert.equal(
      readFileSync(path.join(config.outDir, 'source-prompts.json'), 'utf8'),
      readFileSync(path.join(config.snapshotDir, 'prompt-manifest.json'), 'utf8'),
    )
  })
}
test('already separated policy metadata is also unsupported, with counts on empty builds', () => {
  const config = setup([row('dynamic')], {
    v1: { ...prompt('v1'), toolAvailabilityPolicy: 'single-use-context-v1' },
  })
  assert.throws(
    () => buildDataset(config),
    /no eligible selected examples; exclusion_counts=.*"unsupported_tool_availability_policy":1/,
  )
  assert.equal(existsSync(config.outDir), false)
})
test('evaluation question fingerprint covers earlier context and normalized text', () => {
  const config = setup([
    row('good'),
    row('eval', { input_messages: [{ role: 'user', content: '  FROZEN\n Question ' }] }),
  ])
  config.fingerprints.question_sha256 = [questionHash('frozen question')]
  config.policy.evaluation_fingerprints_sha256 = digest(config.fingerprints)
  write(config.policyPath, config.policy)
  write(config.fingerprintsPath, config.fingerprints)
  buildDataset(config)
  assert.equal(read(path.join(config.outDir, 'export-report.json')).qwen_examples, 1)
})
test('changed review hashes exclude the complete raw row with a counted reason', () => {
  const config = setup([row('good'), row('changed')])
  config.reviews.rows.changed.row_sha256 = 'wrong'
  write(config.reviewsPath, config.reviews)
  buildDataset(config)
  const report = read(path.join(config.outDir, 'export-report.json'))
  assert.equal(report.qwen_examples, 1)
  assert.equal(report.exclusion_counts.changed, 1)
  assert.notEqual(digest(row('1')), digest(row('1', { provider: 'changed-provider' })))
})
test('mixed prompt versions and pruned history cannot collapse', () => {
  const first = row('1', { conversation_id: 'synth-convo' })
  const second = row('2', {
    conversation_id: 'synth-convo',
    turn: 2,
    system_prompt_version: 'v2',
    input_messages: [
      ...first.input_messages,
      ...first.response_messages,
      { role: 'user', content: 'followup' },
    ],
  })
  const config = setup([first, second])
  buildDataset(config)
  const report = read(path.join(config.outDir, 'export-report.json'))
  assert.equal(report.qwen_examples, 2)
  assert.equal(report.inkling_examples, 0)
  const pruned = { ...second, input_messages: [{ role: 'user', content: 'followup' }] }
  assert.equal(resolveRows([first, pruned]).groups[0].collapsible, false)
})
test('branch resolution precedes eligibility and chooses the embedded regeneration', () => {
  const a = row('a', {
    conversation_id: 'synth-c',
    created_at: '2026-01-02',
    response_messages: [{ role: 'assistant', content: 'new' }],
  })
  const b = row('b', {
    conversation_id: 'synth-c',
    created_at: '2026-01-01',
    input_messages: a.input_messages,
    response_messages: [{ role: 'assistant', content: 'old' }],
  })
  const c = row('c', {
    conversation_id: 'synth-c',
    turn: 2,
    input_messages: [
      ...b.input_messages,
      ...b.response_messages,
      { role: 'user', content: 'next' },
    ],
  })
  assert.deepEqual(
    resolveRows([a, b, c]).groups[0].chosen.map((r) => r.id),
    ['b', 'c'],
  )
  const config = setup([a, b, c])
  config.reviews.rows.b.decision = 'pending'
  write(config.reviewsPath, config.reviews)
  buildDataset(config)
  const report = read(path.join(config.outDir, 'export-report.json'))
  assert.equal(report.qwen_examples, 1)
  assert.equal(report.inkling_examples, 0)
  assert.equal(report.exclusion_counts.pending, 1)
  assert.equal(report.exclusion_counts.superseded_branch, 1)
  const exported = readFileSync(path.join(config.outDir, 'ama-traces-qwen.jsonl'), 'utf8').trim()
  assert.equal(JSON.parse(exported).trace_id, 'c')
})
