import { describe, expect, it } from 'vitest'
import { getAmaStreamErrorType, summarizeAmaUiMessage } from '@/lib/ama-stream-diagnostics'

describe('AMA stream diagnostics', () => {
  it('reports message shape and lengths without exposing text or tool output', () => {
    const summary = summarizeAmaUiMessage({
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        { type: 'text', text: ' private answer ' },
        {
          type: 'dynamic-tool',
          toolName: 'search_personal_context',
          toolCallId: 'tool-1',
          state: 'output-available',
          input: { query: 'private query' },
          output: { content: 'private context' },
        },
      ],
    })

    expect(summary).toEqual({
      id: 'assistant-1',
      role: 'assistant',
      partTypes: ['text', 'dynamic-tool'],
      textLength: 16,
      trimmedTextLength: 14,
    })
    expect(JSON.stringify(summary)).not.toContain('private')
  })

  it('reduces errors to their type', () => {
    expect(getAmaStreamErrorType(new TypeError('secret details'))).toBe('TypeError')
    expect(getAmaStreamErrorType('secret details')).toBe('string')
  })
})
