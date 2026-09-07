import { randomUUID } from 'node:crypto'
import { Output, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai'
import { z } from 'zod'

type Model = Parameters<typeof wrapLanguageModel>[0]['model']
type StreamPart =
  Awaited<ReturnType<Model['doStream']>>['stream'] extends ReadableStream<infer Part> ? Part : never
type Finish = Extract<StreamPart, { type: 'finish' }>
type ToolCall = Extract<StreamPart, { type: 'tool-call' }>
type Metadata = Finish['providerMetadata']
type ToolDeclaration = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const MAX_JSON_CHARACTERS = 65536

function invalidArguments(): Error {
  const error = new Error('AMA_ERROR:provider_response')
  error.name = 'AmaStructuredToolCallError'
  return error
}

function mergeMetadata(previous: Metadata, next: Metadata): Metadata {
  return {
    ...previous,
    ...Object.fromEntries(
      Object.entries(next ?? {}).map(([provider, metadata]) => [
        provider,
        { ...previous?.[provider], ...metadata },
      ]),
    ),
  }
}

function argumentSchema(name: string) {
  switch (name) {
    case 'get_public_site_content':
    case 'get_resume':
      return z.object({}).strict()
    case 'search_work_context':
    case 'search_personal_context':
      return z.object({ query: z.string().min(1).max(2000) }).strict()
    default:
      throw new Error('Structured AMA retrieval requires a known context tool.')
  }
}

// The supported argument objects are flat. Count separators outside strings
// so JSON.parse cannot silently replace a duplicated argument key.
function memberCount(text: string): number {
  let quoted = false
  let escaped = false
  let count = 0
  for (const character of text) {
    if (quoted) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        quoted = false
      }
    } else if (character === '"') {
      quoted = true
    } else if (character === ':') {
      count += 1
    }
  }
  return count
}

function middleware(declaration: ToolDeclaration): LanguageModelMiddleware {
  const schema = argumentSchema(declaration.name)
  const output = Output.object({ name: 'ama_tool_arguments', schema })
  const instruction =
    `The application has selected ${declaration.name} for the next retrieval. ` +
    (declaration.name.startsWith('search_')
      ? "Return exactly one JSON object with a single string field named query. Use concise search keywords (at most 2000 characters), including the specific project or work topic and the requested technical detail. Resolve references from the conversation and returned evidence. For a request about one personal project, choose one actual project name from the public result and put that exact name in query. Replace vague phrases such as 'one of my projects' with the chosen name; instructions to choose a project are not search keywords. "
      : 'Return exactly the empty JSON object {}. ') +
    'Return arguments only, with no tool-call markup, explanation, or answer. All source and disclosure restrictions remain in force.'

  function validate(rawJson: string) {
    try {
      if (rawJson.length > MAX_JSON_CHARACTERS) {
        throw invalidArguments()
      }
      const args = schema.parse(JSON.parse(rawJson))
      const query = (args as Record<string, unknown>).query
      if (
        memberCount(rawJson) !== Object.keys(args).length ||
        (typeof query === 'string' && !query.trim())
      ) {
        throw invalidArguments()
      }
    } catch {
      throw invalidArguments()
    }
  }

  function call(
    rawJson: string,
    finish: Pick<Finish, 'finishReason' | 'providerMetadata'>,
  ): ToolCall {
    return {
      type: 'tool-call',
      toolCallId: `ama-context-${randomUUID()}`,
      toolName: declaration.name,
      input: rawJson,
      providerMetadata: {
        ...finish.providerMetadata,
        amaStructuredToolCall: { rawJson, finishReason: finish.finishReason },
      },
    }
  }

  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      // This adapter never chooses a source or broadens SDK execution rights.
      if (params.tools?.length !== 1 || params.tools[0]?.name !== declaration.name) {
        throw invalidArguments()
      }
      const systemIndex = params.prompt.findLastIndex((message) => message.role === 'system')
      const prompt =
        systemIndex < 0
          ? [{ role: 'system' as const, content: instruction }, ...params.prompt]
          : params.prompt.map((message, index) =>
              index === systemIndex && message.role === 'system'
                ? { ...message, content: `${message.content}\n\n${instruction}` }
                : message,
            )
      return {
        ...params,
        prompt,
        toolChoice: { type: 'none' },
        responseFormat: await output.responseFormat,
      }
    },
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate()
      const rawJson = result.content
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('')
      const nonText = result.content.filter((part) => part.type !== 'text')
      const textMetadata = result.content.reduce<Metadata>(
        (metadata, part) =>
          part.type === 'text' ? mergeMetadata(metadata, part.providerMetadata) : metadata,
        undefined,
      )
      const providerMetadata = mergeMetadata(textMetadata, result.providerMetadata)
      // Native attempts are not repaired, filtered, renamed, or replaced.
      if (nonText.some((part) => part.type === 'tool-call')) {
        const audit = {
          rawJson: rawJson.slice(0, MAX_JSON_CHARACTERS),
          rawJsonTruncated: rawJson.length > MAX_JSON_CHARACTERS,
          finishReason: result.finishReason,
          converted: false,
        }
        return {
          ...result,
          content: nonText.map((part) =>
            part.type === 'tool-call'
              ? {
                  ...part,
                  providerMetadata: mergeMetadata(
                    mergeMetadata(providerMetadata, part.providerMetadata),
                    { amaStructuredToolCall: audit },
                  ),
                }
              : part,
          ),
          providerMetadata: mergeMetadata(providerMetadata, {
            amaStructuredToolCall: audit,
          }),
        }
      }
      if (result.finishReason.unified !== 'stop') {
        throw invalidArguments()
      }
      validate(rawJson)
      return { ...result, content: [...nonText, call(rawJson, { ...result, providerMetadata })] }
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream()
      let rawJson = ''
      let rawJsonTruncated = false
      let textId: string | undefined
      let textEnded = false
      let invalidFrame = false
      let nativeActivity = false
      let errorSeen = false
      let finished = false
      let textMetadata: Metadata
      const nativeCalls: ToolCall[] = []

      function emitNativeCalls(
        controller: TransformStreamDefaultController<StreamPart>,
        terminal?: Finish,
      ) {
        const metadata = mergeMetadata(textMetadata, terminal?.providerMetadata)
        for (const nativeCall of nativeCalls.splice(0)) {
          controller.enqueue({
            ...nativeCall,
            providerMetadata: mergeMetadata(mergeMetadata(metadata, nativeCall.providerMetadata), {
              amaStructuredToolCall: {
                rawJson,
                rawJsonTruncated,
                finishReason: terminal?.finishReason ?? null,
                converted: false,
              },
            }),
          })
        }
      }

      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<StreamPart, StreamPart>({
            transform(part, controller) {
              if (finished) {
                controller.enqueue({ type: 'error', error: invalidArguments() })
                return
              }
              if (part.type === 'text-start') {
                textMetadata = mergeMetadata(textMetadata, part.providerMetadata)
                invalidFrame ||= textId !== undefined
                textId = part.id
                return
              }
              if (part.type === 'text-delta') {
                textMetadata = mergeMetadata(textMetadata, part.providerMetadata)
                invalidFrame ||= part.id !== textId || textEnded
                if (rawJson.length + part.delta.length <= MAX_JSON_CHARACTERS) {
                  rawJson += part.delta
                } else {
                  rawJson += part.delta.slice(0, MAX_JSON_CHARACTERS - rawJson.length)
                  rawJsonTruncated = true
                  invalidFrame = true
                }
                return
              }
              if (part.type === 'text-end') {
                textMetadata = mergeMetadata(textMetadata, part.providerMetadata)
                invalidFrame ||= part.id !== textId || textEnded
                textEnded = true
                return
              }
              if (part.type === 'tool-call') {
                nativeActivity = true
                nativeCalls.push(part)
                return
              }
              if (part.type.startsWith('tool-input-')) {
                nativeActivity = true
              }
              if (part.type === 'error') {
                errorSeen = true
              }
              if (part.type === 'finish') {
                emitNativeCalls(controller, part)
                let converted = false
                const providerMetadata = mergeMetadata(textMetadata, part.providerMetadata)
                if (!nativeActivity && !errorSeen) {
                  try {
                    if (invalidFrame || !textEnded || part.finishReason.unified !== 'stop') {
                      throw invalidArguments()
                    }
                    validate(rawJson)
                    const toolCall = call(rawJson, { ...part, providerMetadata })
                    controller.enqueue({
                      type: 'tool-input-start',
                      id: toolCall.toolCallId,
                      toolName: toolCall.toolName,
                    })
                    controller.enqueue({
                      type: 'tool-input-delta',
                      id: toolCall.toolCallId,
                      delta: toolCall.input,
                    })
                    controller.enqueue({ type: 'tool-input-end', id: toolCall.toolCallId })
                    controller.enqueue(toolCall)
                    converted = true
                  } catch {
                    controller.enqueue({ type: 'error', error: invalidArguments() })
                  }
                }
                finished = true
                if (!converted) {
                  controller.enqueue({
                    ...part,
                    providerMetadata: mergeMetadata(providerMetadata, {
                      amaStructuredToolCall: {
                        rawJson,
                        rawJsonTruncated,
                        finishReason: part.finishReason,
                        converted: false,
                      },
                    }),
                  })
                  return
                }
              }
              // Retain reasoning, unexpected attempts, errors, original finish
              // reasons and usage. Only argument JSON text stays private.
              controller.enqueue(part)
            },
            flush(controller) {
              emitNativeCalls(controller)
              if (!finished && !errorSeen) {
                controller.enqueue({ type: 'error', error: invalidArguments() })
              }
            },
          }),
        ),
      }
    },
  }
}

/** Use only for a source already selected by the application's retrieval plan. */
export function withAmaStructuredToolCall(
  model: LanguageModel,
  declaration: ToolDeclaration,
): LanguageModel {
  if (typeof model === 'string' || model.specificationVersion !== 'v3') {
    throw new Error('Structured AMA retrieval requires a resolved language model v3 instance.')
  }
  return wrapLanguageModel({ model, middleware: middleware(declaration) })
}
