import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DefaultChatTransport } from 'ai'
import { useChat } from '@ai-sdk/react'
import { describe, expect, it, vi } from 'vitest'

function createHighChunkResponse(): Response {
  const toolCallId = 'call-search-context'
  const chunks = [
    { type: 'start', messageId: 'assistant-high-chunk' },
    { type: 'start-step' },
    {
      type: 'tool-input-start',
      toolCallId,
      toolName: 'search_personal_context',
      dynamic: true,
    },
    { type: 'tool-input-delta', toolCallId, inputTextDelta: '{"query":"' },
    ...Array.from({ length: 60 }, () => ({
      type: 'tool-input-delta',
      toolCallId,
      inputTextDelta: 'a',
    })),
    { type: 'tool-input-delta', toolCallId, inputTextDelta: '"}' },
    {
      type: 'tool-input-available',
      toolCallId,
      toolName: 'search_personal_context',
      input: { query: 'a'.repeat(60) },
      dynamic: true,
    },
    {
      type: 'tool-output-available',
      toolCallId,
      output: { available: true },
      dynamic: true,
    },
    { type: 'text-start', id: 'answer-text' },
    { type: 'text-delta', id: 'answer-text', delta: 'Final answer survived.' },
    { type: 'text-end', id: 'answer-text' },
    { type: 'finish-step' },
    { type: 'finish', finishReason: 'stop' },
  ]
  const wire = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
  const encoded = new TextEncoder().encode(wire)

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Reproduce the production failure shape: all 70+ UI events arrive in
        // one browser chunk and would otherwise synchronously update React.
        controller.enqueue(encoded)
        controller.close()
      },
    }),
  )
}

function HighChunkChat() {
  const transport = React.useMemo(
    () =>
      new DefaultChatTransport({
        fetch: vi.fn().mockResolvedValue(createHighChunkResponse()),
      }),
    [],
  )
  const { error, messages, sendMessage, status } = useChat({
    transport,
    experimental_throttle: 50,
  })
  const assistantText = messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')

  return (
    <div>
      <button type="button" onClick={() => void sendMessage({ text: 'Test the stream' })}>
        Send
      </button>
      <output data-testid="status">{status}</output>
      <output data-testid="answer">{assistantText}</output>
      <output data-testid="error">{error?.name}</output>
    </div>
  )
}

describe('AMA useChat stream regression', () => {
  it('finishes a single network chunk containing more than 50 tool deltas', async () => {
    render(<HighChunkChat />)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('ready')
      expect(screen.getByTestId('answer')).toHaveTextContent('Final answer survived.')
    })
    expect(screen.getByTestId('error')).toBeEmptyDOMElement()
  })
})
