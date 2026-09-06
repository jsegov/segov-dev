// AI SDK ModelMessages to canonical OpenAI messages. No I/O.
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
export function normalizeMessages(modelMessages) {
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
      const parts =
        typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content
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
