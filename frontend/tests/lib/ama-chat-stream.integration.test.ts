import { describe, expect, it } from 'vitest'
import { Chat } from '@ai-sdk/react'
import {
  DefaultChatTransport,
  ToolLoopAgent,
  consumeStream,
  createAgentUIStreamResponse,
  simulateStreamingMiddleware,
  tool,
  wrapLanguageModel,
  type UIMessage,
} from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'

type GenerateResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>

const usage: GenerateResult['usage'] = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function createToolCall(toolCallId: string, query: string): GenerateResult {
  return {
    content: [
      { type: 'text', text: '\n\n' },
      {
        type: 'tool-call',
        toolCallId,
        toolName: 'search_personal_context',
        input: JSON.stringify({ query }),
      },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage,
    warnings: [],
  }
}

function createAnswer(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  }
}

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

describe('AMA agent UI stream integration', () => {
  it('preserves final assistant text across consecutive tool-calling turns', async () => {
    const responses = [
      createToolCall('tool-first', 'first project'),
      createAnswer('First answer'),
      createToolCall('tool-second', 'second project'),
      createAnswer('Second answer'),
    ]
    let modelCall = 0
    const mockModel = new MockLanguageModelV3({
      doGenerate: async () => responses[modelCall++]!,
    })
    const model = wrapLanguageModel({
      model: mockModel,
      middleware: simulateStreamingMiddleware(),
    })
    const agent = new ToolLoopAgent({
      model,
      tools: {
        search_personal_context: tool({
          inputSchema: z.object({ query: z.string() }),
          execute: async ({ query }) => ({ available: true, content: `Context for ${query}` }),
        }),
      },
    })
    const transport = new DefaultChatTransport({
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: UIMessage[] }
        return createAgentUIStreamResponse({
          agent,
          uiMessages: body.messages,
          consumeSseStream: ({ stream }) => consumeStream({ stream }),
        })
      },
    })
    const chat = new Chat({
      messages: [
        {
          id: 'initial',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Ask me anything.' }],
        },
      ],
      transport,
    })

    await chat.sendMessage({ text: 'First project?' })
    await chat.sendMessage({ text: 'Second project?' })

    const assistantMessages = chat.messages.filter(
      (message) => message.role === 'assistant' && message.id !== 'initial',
    )
    expect(assistantMessages.map(getMessageText)).toEqual(['\n\nFirst answer', '\n\nSecond answer'])
    expect(assistantMessages[1]?.parts.map((part) => part.type)).toEqual([
      'step-start',
      'text',
      'tool-search_personal_context',
      'step-start',
      'text',
    ])
    expect(chat.status).toBe('ready')
    expect(chat.error).toBeUndefined()
    expect(modelCall).toBe(4)
  })
})
