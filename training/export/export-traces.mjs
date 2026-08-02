// Export ama_traces rows into training JSONL files:
//   data/export/ama-traces-qwen.jsonl     — one example per turn (LAST_ASSISTANT_TURN at train time)
//   data/export/ama-traces-inkling.jsonl  — one example per stitched conversation (ALL_ASSISTANT_MESSAGES)
//   data/export/prompt-manifest.json      — system prompt + tool declarations + call settings per version
//   data/export/export-report.json        — resolution/exclusion stats + file hashes
//
// Usage:
//   DATABASE_URL='postgresql://…' pnpm --filter ama-training export
//
// Env:
//   DATABASE_URL        (required) Neon connection string for segov-dev-ama-traces
//   TRACE_ID_LIKE       conversation_id filter, default 'synth-0730%'
//   TRACE_ID_NOT_LIKE   exclusion filter, default 'synth-0730b-smoke%'
//
// Resolution rules (docs/ama-fine-tuning-experiment.md, "From per-turn traces to
// training conversations"):
//   1. Branch resolution for duplicate (conversation_id, turn) rows.
//   2. Canonicalize parallel tool-result order to the assistant's call order,
//      then prefix-consistency stitch check.
//   3. Turns with finish_reason != 'stop' are never training targets (truncated
//      output); conversations containing them fall out of the collapsed export
//      but later turns still export per-turn.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { neon } from '@neondatabase/serverless'

const dir = path.dirname(new URL(import.meta.url).pathname)
const outDir = path.join(dir, '..', 'data', 'export')
mkdirSync(outDir, { recursive: true })

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) throw new Error('DATABASE_URL required')
const sql = neon(DATABASE_URL)

const ID_LIKE = process.env.TRACE_ID_LIKE ?? 'synth-0730%'
const ID_NOT_LIKE = process.env.TRACE_ID_NOT_LIKE ?? 'synth-0730b-smoke%'

// ---------- fetch ----------

async function fetchAllRows() {
  const rows = []
  let cursor = { cid: '', id: '00000000-0000-0000-0000-000000000000' }
  for (;;) {
    const page = await sql`
      SELECT id, conversation_id, turn, system_prompt_version, model, response_model,
             finish_reason, input_messages, response_messages, total_usage, created_at
      FROM ama_traces
      WHERE conversation_id LIKE ${ID_LIKE}
        AND conversation_id NOT LIKE ${ID_NOT_LIKE}
        AND (conversation_id, id::text) > (${cursor.cid}, ${cursor.id})
      ORDER BY conversation_id, id::text
      LIMIT 40
    `
    if (page.length === 0) break
    rows.push(...page)
    const last = page[page.length - 1]
    cursor = { cid: last.conversation_id, id: last.id }
    process.stderr.write(`fetched ${rows.length} rows\r`)
  }
  process.stderr.write(`fetched ${rows.length} rows\n`)
  return rows
}

// ---------- ModelMessage -> OpenAI-style normalization ----------

function textOf(parts) {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

function toolResultContent(part) {
  const out = part.output
  if (out && out.type === 'json') return JSON.stringify(out.value)
  if (out && (out.type === 'text' || out.type === 'error-text')) return out.value ?? out.text ?? ''
  return JSON.stringify(out)
}

// Normalizes a ModelMessage[] into OpenAI-format messages. Reasoning parts and
// providerOptions are dropped. Tool-result parts are re-ordered to match the
// preceding assistant message's tool-call order (rule 2) and split one message
// per result. Returns { messages, reordered }.
function normalizeMessages(modelMessages) {
  const out = []
  let lastToolCallOrder = []
  let reordered = 0
  let i = 0
  while (i < modelMessages.length) {
    const msg = modelMessages[i]
    if (msg.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : textOf(msg.content)
      out.push({ role: 'user', content })
      i += 1
    } else if (msg.role === 'assistant') {
      const parts = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content
      const text = textOf(parts)
      const toolCalls = parts
        .filter((p) => p.type === 'tool-call')
        .map((p) => ({
          id: p.toolCallId,
          type: 'function',
          function: { name: p.toolName, arguments: JSON.stringify(p.input ?? {}) },
        }))
      const entry = { role: 'assistant', content: text.length > 0 ? text : null }
      if (toolCalls.length > 0) {
        entry.tool_calls = toolCalls
        lastToolCallOrder = toolCalls.map((c) => c.id)
      }
      out.push(entry)
      i += 1
    } else if (msg.role === 'tool') {
      // Collect consecutive tool messages, flatten their result parts.
      const parts = []
      while (i < modelMessages.length && modelMessages[i].role === 'tool') {
        parts.push(...modelMessages[i].content)
        i += 1
      }
      const order = new Map(lastToolCallOrder.map((id, idx) => [id, idx]))
      const sorted = [...parts].sort(
        (a, b) => (order.get(a.toolCallId) ?? 999) - (order.get(b.toolCallId) ?? 999),
      )
      if (sorted.some((p, idx) => p !== parts[idx])) reordered += 1
      for (const p of sorted) {
        out.push({
          role: 'tool',
          tool_call_id: p.toolCallId,
          name: p.toolName,
          content: toolResultContent(p),
        })
      }
    } else if (msg.role === 'system') {
      out.push({ role: 'system', content: msg.content })
      i += 1
    } else {
      throw new Error(`unknown role ${msg.role}`)
    }
  }
  return { messages: out, reordered }
}

const key = (messages) => JSON.stringify(messages)

// ---------- resolution ----------

const rows = await fetchAllRows()

const byConversation = new Map()
for (const row of rows) {
  if (!byConversation.has(row.conversation_id)) byConversation.set(row.conversation_id, [])
  byConversation.get(row.conversation_id).push(row)
}

const report = {
  filters: { like: ID_LIKE, notLike: ID_NOT_LIKE },
  rowsFetched: rows.length,
  conversations: byConversation.size,
  duplicateTurnGroups: [],
  toolMessagesReordered: 0,
  stitchFailures: [],
  nonStopTurnsExcluded: [],
  qwenExamples: 0,
  inklingConversations: 0,
  perTurnOnlyConversations: [],
}

const qwenLines = []
const inklingLines = []

const conversationIds = [...byConversation.keys()].sort()
for (const cid of conversationIds) {
  const convoRows = byConversation.get(cid)
  const byTurn = new Map()
  for (const row of convoRows) {
    if (!byTurn.has(row.turn)) byTurn.set(row.turn, [])
    byTurn.get(row.turn).push(row)
  }
  const turns = [...byTurn.keys()].sort((a, b) => a - b)

  // Pre-normalize every candidate row.
  const norm = new Map() // row.id -> {input, response, reordered}
  for (const row of convoRows) {
    const input = normalizeMessages(row.input_messages)
    const response = normalizeMessages(row.response_messages)
    norm.set(row.id, {
      input: input.messages,
      response: response.messages,
      reordered: input.reordered + response.reordered,
    })
  }

  // Walk turns in order, choosing one branch per turn (rule 1) and verifying
  // the stitch (rule 2).
  let prefix = null // normalized chosen history: input(t)+response(t) of last chosen row
  let collapsible = true
  const chosen = []
  for (const turn of turns) {
    const candidates = byTurn.get(turn)
    let viable = candidates
    if (prefix !== null) {
      viable = candidates.filter((row) => {
        const n = norm.get(row.id)
        return (
          n.input.length === prefix.length + 1 &&
          key(n.input.slice(0, -1)) === key(prefix) &&
          n.input[n.input.length - 1].role === 'user'
        )
      })
    }
    if (candidates.length > 1) {
      report.duplicateTurnGroups.push({
        conversation_id: cid,
        turn,
        candidates: candidates.length,
        viable: viable.length,
      })
    }
    let pick
    if (viable.length === 0) {
      // No candidate stitches onto the chosen history — take the latest row and
      // drop the conversation to per-turn-only export.
      pick = [...candidates].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
      collapsible = false
      report.stitchFailures.push({ conversation_id: cid, turn })
    } else if (viable.length === 1) {
      pick = viable[0]
    } else {
      // Sibling regenerations that both stitch: prefer the one embedded in the
      // next turn's input; fall back to latest created_at.
      const nextTurnRows = byTurn.get(turn + 1) ?? []
      pick =
        viable.find((row) => {
          const n = norm.get(row.id)
          const full = key([...n.input, ...n.response])
          return nextTurnRows.some((next) => {
            const nn = norm.get(next.id)
            return key(nn.input.slice(0, -1)) === full
          })
        }) ?? [...viable].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
    }
    const n = norm.get(pick.id)
    report.toolMessagesReordered += n.reordered
    chosen.push(pick)
    prefix = [...n.input, ...n.response]
  }

  // Turn contiguity: turns must be 1..N for a collapsed export.
  const contiguous = turns.every((t, idx) => t === idx + 1)
  if (!contiguous) collapsible = false

  // Emit per-turn (Qwen) examples; non-stop turns are excluded as targets.
  for (const row of chosen) {
    const n = norm.get(row.id)
    if (row.finish_reason !== 'stop') {
      report.nonStopTurnsExcluded.push({
        conversation_id: cid,
        turn: row.turn,
        finish_reason: row.finish_reason,
      })
      collapsible = false
      continue
    }
    qwenLines.push(
      JSON.stringify({
        conversation_id: cid,
        turn: row.turn,
        trace_id: row.id,
        system_prompt_version: row.system_prompt_version,
        model: row.model,
        messages: [...n.input, ...n.response],
      }),
    )
    report.qwenExamples += 1
  }

  if (collapsible) {
    const last = chosen[chosen.length - 1]
    const n = norm.get(last.id)
    inklingLines.push(
      JSON.stringify({
        conversation_id: cid,
        turns: chosen.length,
        trace_ids: chosen.map((row) => row.id),
        system_prompt_version: last.system_prompt_version,
        model: last.model,
        messages: [...n.input, ...n.response],
      }),
    )
    report.inklingConversations += 1
  } else {
    report.perTurnOnlyConversations.push(cid)
  }
}

// ---------- prompt manifest ----------

const versions = [...new Set(rows.map((row) => row.system_prompt_version))]
const manifest = {}
for (const version of versions) {
  const [row] = await sql`
    SELECT version, instructions, tool_declarations, call_settings
    FROM ama_prompt_versions WHERE version = ${version}
  `
  manifest[version] = row
}

// ---------- write ----------

function writeWithHash(name, content) {
  const filePath = path.join(outDir, name)
  writeFileSync(filePath, content)
  return createHash('sha256').update(content).digest('hex')
}

const hashes = {
  'ama-traces-qwen.jsonl': writeWithHash('ama-traces-qwen.jsonl', qwenLines.join('\n') + '\n'),
  'ama-traces-inkling.jsonl': writeWithHash(
    'ama-traces-inkling.jsonl',
    inklingLines.join('\n') + '\n',
  ),
  'prompt-manifest.json': writeWithHash('prompt-manifest.json', JSON.stringify(manifest, null, 2)),
}
report.sha256 = hashes
writeWithHash('export-report.json', JSON.stringify(report, null, 2))

console.log(
  JSON.stringify(
    {
      ...report,
      perTurnOnlyConversations: report.perTurnOnlyConversations.length,
      stitchFailureCount: report.stitchFailures.length,
    },
    null,
    2,
  ),
)
