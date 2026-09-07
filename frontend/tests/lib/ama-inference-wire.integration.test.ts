import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAmaLanguageModel } from '@/lib/ama-model-config'
import { AMA_TOOL_DECLARATIONS } from '@/lib/ama-agent'

afterEach(() => vi.unstubAllGlobals())

describe('AMA compatible provider wire contract', () => {
  it.each(['generate', 'stream'] as const)(
    'sends explicit no-tools choice through the real %s adapter',
    async (mode) => {
      const bodies: Record<string, unknown>[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init: RequestInit) => {
          bodies.push(JSON.parse(String(init.body)))
          return mode === 'stream'
            ? new Response(
                'data: {"choices":[{"index":0,"delta":{"content":"Synthetic answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                { headers: { 'Content-Type': 'text/event-stream' } },
              )
            : Response.json({
                choices: [
                  {
                    message: { role: 'assistant', content: 'Synthetic answer' },
                    finish_reason: 'stop',
                  },
                ],
              })
        }),
      )
      const model = resolveAmaLanguageModel({
        model: 'synthetic-model',
        inference: { baseURL: 'https://inference.example.test/v1' },
      })
      if (typeof model === 'string' || model.specificationVersion !== 'v3') {
        throw new Error('Expected a v3 inference model')
      }
      for (const tools of [undefined, []]) {
        const options = {
          prompt: [
            { role: 'user' as const, content: [{ type: 'text' as const, text: 'Question' }] },
          ],
          tools,
          toolChoice: { type: 'none' as const },
        }
        if (mode === 'stream') {
          const result = await model.doStream(options)
          await result.stream.pipeTo(new WritableStream())
        } else {
          await model.doGenerate(options)
        }
      }
      expect(bodies).toHaveLength(2)
      for (const body of bodies) {
        expect(body.tool_choice).toBe('none')
        expect(body.tools).toBeUndefined()
        expect(body.messages).toEqual([{ role: 'user', content: 'Question' }])
      }
    },
  )

  it('preserves named and automatic choices when tools are available', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return Response.json({
          choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }],
        })
      }),
    )
    const model = resolveAmaLanguageModel({
      model: 'synthetic',
      inference: { baseURL: 'https://inference.example.test/v1' },
    })
    if (typeof model === 'string' || model.specificationVersion !== 'v3') {
      throw new Error('Expected a v3 inference model')
    }
    const tool = {
      type: 'function' as const,
      name: 'get_resume',
      inputSchema: { type: 'object' as const, properties: {} },
    }
    for (const toolChoice of [
      { type: 'tool' as const, toolName: 'get_resume' },
      { type: 'auto' as const },
    ]) {
      await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Question' }] }],
        tools: [tool],
        toolChoice,
      })
    }
    expect(bodies[0]?.tool_choice).toEqual({ type: 'function', function: { name: 'get_resume' } })
    expect(bodies[1]?.tool_choice).toBe('auto')
    expect(bodies.every((body) => Array.isArray(body.tools) && body.tools.length === 1)).toBe(true)
  })

  it('declares no arguments for lookups that do not use model input', () => {
    for (const name of ['get_public_site_content', 'get_resume']) {
      expect(AMA_TOOL_DECLARATIONS.find((tool) => tool.name === name)?.inputSchema).toMatchObject({
        type: 'object',
        properties: {},
        additionalProperties: false,
      })
    }
  })

  it('sends a strict final-answer schema with disabled calls and stable declarations', async () => {
    let body: Record<string, unknown> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        body = JSON.parse(String(init.body))
        return Response.json({
          choices: [
            {
              message: { role: 'assistant', content: '{"answer":"I built it."}' },
              finish_reason: 'stop',
            },
          ],
        })
      }),
    )
    const model = resolveAmaLanguageModel(
      { model: 'synthetic', inference: { baseURL: 'https://inference.example.test/v1' } },
      AMA_TOOL_DECLARATIONS,
    )
    if (typeof model === 'string' || model.specificationVersion !== 'v3') {
      throw new Error('Expected v3 inference')
    }
    const schema = {
      type: 'object' as const,
      properties: { answer: { type: 'string' as const } },
      required: ['answer'],
      additionalProperties: false,
    }
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Question' }] }],
      tools: [],
      toolChoice: { type: 'none' },
      responseFormat: { type: 'json', name: 'ama_answer', schema },
    })
    expect(body?.tool_choice).toBe('none')
    expect(body?.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'ama_answer', strict: true, schema },
    })
    expect(body?.tools).toEqual(
      AMA_TOOL_DECLARATIONS.map(({ name, description, inputSchema }) => ({
        type: 'function',
        function: { name, description, parameters: inputSchema },
      })),
    )
  })
})
