// Acquisition is explicit and online. Dataset construction is deterministic and offline.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeMessages } from './normalize.mjs'

export function canonical(value) {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    )
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite number')
  return value
}
export function canonicalJson(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite number')
  return JSON.stringify(value)
}
export const digest = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex')
const fileHash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const json = (file) => JSON.parse(readFileSync(file, 'utf8'))
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
const write = (dir, name, value) =>
  writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + '\n')
export const seal = (value) => ({ ...value, artifact_sha256: digest(value) })
export function verify(value, kind) {
  const { artifact_sha256, ...payload } = value
  if (value.schema_version !== 1 || value.kind !== kind || digest(payload) !== artifact_sha256)
    throw new Error(`invalid ${kind} manifest`)
  return value
}
function newDirectory(dir) {
  if (existsSync(dir)) throw new Error(`output already exists: ${dir}`)
  mkdirSync(dir, { recursive: true })
}
export const questionHash = (text) =>
  digest(text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim())

export function writeSnapshot(rows, prompts, outDir, filters = {}) {
  if (!rows.length || new Set(rows.map((r) => r.id)).size !== rows.length)
    throw new Error('snapshot needs nonempty unique trace IDs')
  newDirectory(outDir)
  writeFileSync(
    path.join(outDir, 'traces.jsonl'),
    rows.map((r) => JSON.stringify(canonical(r))).join('\n') + '\n',
  )
  write(outDir, 'prompt-manifest.json', prompts)
  const manifest = seal({
    schema_version: 1,
    kind: 'ama_snapshot',
    filters,
    row_count: rows.length,
    files: Object.fromEntries(
      ['traces.jsonl', 'prompt-manifest.json'].map((f) => [f, fileHash(path.join(outDir, f))]),
    ),
  })
  write(outDir, 'snapshot-manifest.json', manifest)
  write(outDir, 'review-manifest.template.json', {
    schema_version: 1,
    snapshot_sha256: manifest.artifact_sha256,
    rows: Object.fromEntries(
      rows.map((r) => [
        r.id,
        {
          row_sha256: digest(r),
          decision: 'pending',
          corpus_class: 'synthetic',
          family_id: null,
          reason: '',
        },
      ]),
    ),
  })
  write(outDir, 'policy.template.json', {
    schema_version: 1,
    corpus_class: 'synthetic',
    allowed_models: [],
    allowed_response_models: [],
    allowed_prompt_versions: [],
    conversation_prefixes: ['synth-'],
    evaluation_fingerprints_sha256: null,
  })
  return manifest
}

export function resolveRows(rows) {
  const groups = new Map()
  for (const row of rows) {
    if (!groups.has(row.conversation_id)) groups.set(row.conversation_id, [])
    groups.get(row.conversation_id).push(row)
  }
  const normalized = new Map(
    rows.map((row) => [
      row.id,
      {
        input: normalizeMessages(row.input_messages).messages,
        response: normalizeMessages(row.response_messages).messages,
      },
    ]),
  )
  const result = []
  const latest = (rs) =>
    [...rs].sort(
      (a, b) =>
        String(b.created_at).localeCompare(String(a.created_at)) ||
        String(b.id).localeCompare(String(a.id)),
    )[0]
  for (const [cid, conversation] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const turns = [...new Set(conversation.map((r) => r.turn))].sort((a, b) => a - b)
    let prefix = null
    let collapsible = turns.every((t, i) => t === i + 1)
    const chosen = []
    for (const turn of turns) {
      const candidates = conversation.filter((r) => r.turn === turn)
      const viable = candidates.filter((r) => {
        const n = normalized.get(r.id)
        return (
          prefix === null ||
          (n.input.length === prefix.length + 1 &&
            n.input.at(-1)?.role === 'user' &&
            digest(n.input.slice(0, -1)) === digest(prefix))
        )
      })
      const embedded = viable.filter((r) => {
        const n = normalized.get(r.id)
        return conversation.some(
          (next) =>
            next.turn === turn + 1 &&
            digest(normalized.get(next.id).input.slice(0, -1)) ===
              digest([...n.input, ...n.response]),
        )
      })
      const pick = latest(embedded.length ? embedded : viable.length ? viable : candidates)
      if (!viable.length) collapsible = false
      chosen.push(pick)
      const n = normalized.get(pick.id)
      prefix = [...n.input, ...n.response]
    }
    result.push({ cid, chosen, collapsible })
  }
  return { groups: result, normalized }
}

export function buildDataset({ snapshotDir, policyPath, reviewsPath, fingerprintsPath, outDir }) {
  const snapshot = verify(json(path.join(snapshotDir, 'snapshot-manifest.json')), 'ama_snapshot')
  for (const [name, hash] of Object.entries(snapshot.files)) {
    if (
      !['traces.jsonl', 'prompt-manifest.json'].includes(name) ||
      fileHash(path.join(snapshotDir, name)) !== hash
    )
      throw new Error('snapshot file changed')
  }
  const rows = lines(path.join(snapshotDir, 'traces.jsonl'))
  const prompts = json(path.join(snapshotDir, 'prompt-manifest.json'))
  const policy = json(policyPath),
    reviews = json(reviewsPath),
    fingerprints = json(fingerprintsPath)
  if (
    policy.schema_version !== 1 ||
    policy.corpus_class !== 'synthetic' ||
    ![
      'allowed_models',
      'allowed_response_models',
      'allowed_prompt_versions',
      'conversation_prefixes',
    ].every(
      (k) =>
        Array.isArray(policy[k]) &&
        policy[k].length &&
        policy[k].every((v) => typeof v === 'string' && v.length),
    )
  )
    throw new Error('explicit synthetic-only teacher/model/prompt policy required')
  if (
    fingerprints.schema_version !== 1 ||
    !fingerprints.dataset_sha256 ||
    !fingerprints.selection_dataset_sha256 ||
    !fingerprints.final_dataset_sha256 ||
    !Array.isArray(fingerprints.question_sha256) ||
    !Array.isArray(fingerprints.family_ids) ||
    policy.evaluation_fingerprints_sha256 !== digest(fingerprints)
  )
    throw new Error('evaluation fingerprints missing or changed')
  if (reviews.schema_version !== 1 || reviews.snapshot_sha256 !== snapshot.artifact_sha256)
    throw new Error('reviews belong to another snapshot')
  const ids = new Set(rows.map((r) => r.id))
  if (Object.keys(reviews.rows).some((id) => !ids.has(id)))
    throw new Error('review references unknown trace')
  const eligible = new Set(),
    excluded = []
  for (const row of rows) {
    const review = reviews.rows[row.id]
    let reason
    if (review && review.row_sha256 !== digest(row)) reason = 'changed'
    else if (review?.decision === 'rejected') reason = 'rejected'
    else if (review?.decision !== 'approved') reason = 'pending'
    else if (
      review.corpus_class !== 'synthetic' ||
      !policy.conversation_prefixes.some((p) => row.conversation_id.startsWith(p))
    )
      reason = 'non_synthetic'
    else if (!review.family_id || !review.reason?.trim())
      throw new Error(`approved trace needs family and review reason: ${row.id}`)
    else if (
      !policy.allowed_models.includes(row.model) ||
      !policy.allowed_response_models.includes(row.response_model)
    )
      reason = 'teacher_model'
    else if (
      !policy.allowed_prompt_versions.includes(row.system_prompt_version) ||
      !prompts[row.system_prompt_version]
    )
      reason = 'prompt_version'
    else if (row.finish_reason !== 'stop') reason = 'non_stop'
    else if (
      fingerprints.family_ids.includes(review.family_id) ||
      normalizeMessages(row.input_messages).messages.some(
        (m) => m.role === 'user' && fingerprints.question_sha256.includes(questionHash(m.content)),
      )
    )
      reason = 'evaluation_contamination'
    if (reason) excluded.push({ trace_id: row.id, reason })
    else eligible.add(row.id)
  }
  // Resolve against the complete snapshot. Filtering first could silently select a different regeneration.
  const { groups, normalized } = resolveRows(rows)
  const selectedIds = new Set(groups.flatMap(({ chosen }) => chosen.map((row) => row.id)))
  for (const row of rows) {
    if (eligible.has(row.id) && !selectedIds.has(row.id))
      excluded.push({ trace_id: row.id, reason: 'superseded_branch' })
  }
  const qwen = [],
    inkling = [],
    collapsedExcluded = []
  for (const { cid, chosen, collapsible } of groups) {
    const selected = chosen.filter((r) => eligible.has(r.id))
    for (const row of selected) {
      const n = normalized.get(row.id)
      qwen.push({
        conversation_id: cid,
        turn: row.turn,
        trace_id: row.id,
        family_ids: [reviews.rows[row.id].family_id],
        system_prompt_version: row.system_prompt_version,
        model: row.model,
        messages: [...n.input, ...n.response],
      })
    }
    if (
      selected.length !== chosen.length ||
      !collapsible ||
      new Set(chosen.map((r) => r.system_prompt_version)).size !== 1
    ) {
      collapsedExcluded.push(cid)
      continue
    }
    const last = chosen.at(-1),
      n = normalized.get(last.id)
    inkling.push({
      conversation_id: cid,
      turns: chosen.length,
      trace_ids: chosen.map((r) => r.id),
      family_ids: [...new Set(chosen.map((r) => reviews.rows[r.id].family_id))].sort(),
      system_prompt_version: last.system_prompt_version,
      model: last.model,
      messages: [...n.input, ...n.response],
    })
  }
  if (!qwen.length) throw new Error('no eligible selected examples')
  newDirectory(outDir)
  const documents = {
    'prompt-manifest.json': prompts,
    'policy.json': policy,
    'reviews.json': reviews,
    'evaluation-fingerprints.json': fingerprints,
    'snapshot-manifest.json': snapshot,
    'export-report.json': {
      excluded,
      exclusion_counts: excluded.reduce(
        (counts, row) => {
          counts[row.reason] = (counts[row.reason] ?? 0) + 1
          return counts
        },
        {
          pending: 0,
          rejected: 0,
          changed: 0,
          non_synthetic: 0,
          teacher_model: 0,
          prompt_version: 0,
          non_stop: 0,
          evaluation_contamination: 0,
          superseded_branch: 0,
        },
      ),
      snapshot_rows: rows.length,
      excluded_rows: excluded.length,
      collapsed_excluded: collapsedExcluded,
      collapsed_excluded_count: collapsedExcluded.length,
      qwen_examples: qwen.length,
      inkling_examples: inkling.length,
    },
  }
  for (const [name, doc] of Object.entries(documents)) write(outDir, name, doc)
  writeFileSync(
    path.join(outDir, 'source-traces.jsonl'),
    readFileSync(path.join(snapshotDir, 'traces.jsonl')),
  )
  writeFileSync(
    path.join(outDir, 'source-prompts.json'),
    readFileSync(path.join(snapshotDir, 'prompt-manifest.json')),
  )
  for (const [name, data] of [
    ['ama-traces-qwen.jsonl', qwen],
    ['ama-traces-inkling.jsonl', inkling],
  ])
    writeFileSync(
      path.join(outDir, name),
      data.map((r) => JSON.stringify(canonical(r))).join('\n') + (data.length ? '\n' : ''),
    )
  const names = [
    ...Object.keys(documents),
    'source-traces.jsonl',
    'source-prompts.json',
    'ama-traces-qwen.jsonl',
    'ama-traces-inkling.jsonl',
  ]
  const manifest = seal({
    schema_version: 1,
    kind: 'ama_dataset',
    corpus_class: 'synthetic',
    snapshot_sha256: snapshot.artifact_sha256,
    files: Object.fromEntries(names.map((name) => [name, fileHash(path.join(outDir, name))])),
  })
  write(outDir, 'dataset-manifest.json', manifest)
  return manifest
}

async function snapshotOnline(outDir) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for snapshot acquisition')
  const { neon } = await import('@neondatabase/serverless')
  const sql = neon(process.env.DATABASE_URL)
  const like = process.env.TRACE_ID_LIKE ?? 'synth-%',
    notLike = process.env.TRACE_ID_NOT_LIKE ?? 'synth-smoke%'
  const rows = []
  let cursor = ''
  for (;;) {
    const page =
      await sql`SELECT * FROM ama_traces WHERE conversation_id LIKE ${like} AND conversation_id NOT LIKE ${notLike} AND id > ${cursor} ORDER BY id LIMIT 40`
    if (!page.length) break
    rows.push(...page)
    cursor = page.at(-1).id
  }
  const prompts = {}
  for (const version of [...new Set(rows.map((r) => r.system_prompt_version))].sort()) {
    const [prompt] =
      await sql`SELECT version, instructions, tool_declarations, call_settings FROM ama_prompt_versions WHERE version = ${version}`
    if (!prompt) throw new Error(`missing prompt version ${version}`)
    prompts[version] = prompt
  }
  return writeSnapshot(rows, prompts, outDir, { like, not_like: notLike })
}

async function main(argv) {
  const [command, ...rest] = argv
  const opts = {}
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || !rest[i + 1]) throw new Error('use --name value arguments')
    opts[rest[i].slice(2)] = rest[i + 1]
  }
  if (!opts.out)
    throw new Error(
      'usage: export-traces.mjs snapshot --out NEW_DIR | build --snapshot DIR --policy FILE --reviews FILE --fingerprints FILE --out NEW_DIR',
    )
  if (command === 'snapshot') return snapshotOnline(opts.out)
  if (
    command === 'build' &&
    ['snapshot', 'policy', 'reviews', 'fingerprints'].every((k) => opts[k])
  )
    return buildDataset({
      snapshotDir: opts.snapshot,
      policyPath: opts.policy,
      reviewsPath: opts.reviews,
      fingerprintsPath: opts.fingerprints,
      outDir: opts.out,
    })
  throw new Error('snapshot and build are separate explicit commands')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2))
    .then((result) => console.log(result.artifact_sha256))
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
