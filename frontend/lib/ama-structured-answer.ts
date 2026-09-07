import { Output, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai'
import { z } from 'zod'

type Model = Parameters<typeof wrapLanguageModel>[0]['model']
type StreamPart =
  Awaited<ReturnType<Model['doStream']>>['stream'] extends ReadableStream<infer Part> ? Part : never
type TextEnd = Extract<StreamPart, { type: 'text-end' }>

const answerSchema = z.object({ answer: z.string() }).strict()
const answerOutput = Output.object({ name: 'ama_answer', schema: answerSchema })
const MAX_JSON_CHARACTERS = 65536
const FORMAT_INSTRUCTION =
  'For this final answer, return exactly one JSON object with a single string field named answer. Put the complete user-facing answer in that field. All source and disclosure restrictions remain in force.'

function invalidAnswer(): Error {
  // The existing route classifies this token without exposing parser input.
  const error = new Error('AMA_ERROR:provider_response')
  error.name = 'AmaStructuredAnswerError'
  return error
}

function completeAnswer(text: string): string {
  try {
    const { answer } = answerSchema.parse(JSON.parse(text))
    if (
      !answer.trim() ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(answer)
    ) {
      throw invalidAnswer()
    }
    return answer
  } catch {
    throw invalidAnswer()
  }
}

function createStructuredAnswerMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      const systemIndex = params.prompt.findLastIndex((message) => message.role === 'system')
      const prompt =
        systemIndex < 0
          ? [{ role: 'system' as const, content: FORMAT_INSTRUCTION }, ...params.prompt]
          : params.prompt.map((message, index) =>
              index === systemIndex && message.role === 'system'
                ? { ...message, content: `${message.content}\n\n${FORMAT_INSTRUCTION}` }
                : message,
            )
      return { ...params, prompt, responseFormat: await answerOutput.responseFormat }
    },
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate()
      // Preserve unexpected calls for normal SDK rejection and scoring.
      if (result.content.some((part) => part.type === 'tool-call')) {
        return result
      }
      const rawJson = result.content
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('')
      if (rawJson.length > MAX_JSON_CHARACTERS) {
        throw invalidAnswer()
      }
      const answer = completeAnswer(rawJson)
      let firstText = true
      return {
        ...result,
        content: result.content.map((part) => {
          if (part.type !== 'text') {
            return part
          }
          const text = firstText ? answer : ''
          firstText = false
          return {
            ...part,
            text,
            providerMetadata: {
              ...part.providerMetadata,
              amaStructuredAnswer: { rawJson },
            },
          }
        }),
      }
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream()
      let rawJson = ''
      let emittedAnswer = ''
      let textId: string | undefined
      let textEnd: TextEnd | undefined
      let terminalSeen = false
      let toolActivity = false
      let providerError = false

      function emitAnswer(
        answer: string,
        controller: TransformStreamDefaultController<StreamPart>,
        providerMetadata?: Extract<StreamPart, { type: 'text-delta' }>['providerMetadata'],
      ) {
        // A JSON escape or literal Unicode character can straddle chunks.
        const stableAnswer = answer.replace(/[\uD800-\uDBFF]$/, '')
        if (!stableAnswer.startsWith(emittedAnswer) || textId === undefined) {
          throw invalidAnswer()
        }
        const delta = stableAnswer.slice(emittedAnswer.length)
        if (delta || providerMetadata) {
          controller.enqueue({ type: 'text-delta', id: textId, delta, providerMetadata })
        }
        emittedAnswer = stableAnswer
      }

      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<StreamPart, StreamPart>({
            async transform(part, controller) {
              if (part.type === 'text-start') {
                if (textId !== undefined) {
                  throw invalidAnswer()
                }
                textId = part.id
                controller.enqueue(part)
                return
              }
              if (part.type === 'text-delta') {
                if (part.id !== textId || textEnd) {
                  throw invalidAnswer()
                }
                rawJson += part.delta
                if (rawJson.length > MAX_JSON_CHARACTERS) {
                  throw invalidAnswer()
                }
                const parsed = await answerOutput.parsePartialOutput({ text: rawJson })
                if (parsed?.partial && typeof parsed.partial.answer === 'string') {
                  emitAnswer(parsed.partial.answer, controller, part.providerMetadata)
                } else if (part.providerMetadata) {
                  controller.enqueue({ ...part, delta: '' })
                }
                return
              }
              if (part.type === 'text-end') {
                if (part.id !== textId || textEnd) {
                  throw invalidAnswer()
                }
                // Validate the entire object before closing the decoded text.
                textEnd = part
                return
              }
              if (part.type === 'tool-call' || part.type.startsWith('tool-input-')) {
                toolActivity = true
              }
              if (part.type === 'error') {
                providerError = true
                terminalSeen = true
              }
              if (part.type === 'finish') {
                if (!toolActivity && !providerError) {
                  emitAnswer(completeAnswer(rawJson), controller)
                }
                if (textId !== undefined) {
                  controller.enqueue({
                    ...textEnd,
                    type: 'text-end',
                    id: textId,
                    providerMetadata: {
                      ...textEnd?.providerMetadata,
                      amaStructuredAnswer: { rawJson },
                    },
                  })
                }
                terminalSeen = true
              }
              // In particular, do not conceal reasoning or unexpected calls,
              // or replace their provider finish reasons with a fabricated stop.
              controller.enqueue(part)
            },
            flush() {
              if (!terminalSeen) {
                throw invalidAnswer()
              }
            },
          }),
        ),
      }
    },
  }
}

/** Select only for a final, no-tools step; this does not change model weights. */
export function withAmaStructuredAnswer(model: LanguageModel): LanguageModel {
  if (typeof model === 'string' || model.specificationVersion !== 'v3') {
    throw new Error('Structured AMA answers require a resolved language model v3 instance.')
  }
  return wrapLanguageModel({ model, middleware: createStructuredAnswerMiddleware() })
}
