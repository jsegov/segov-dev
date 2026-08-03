import {
  NoOutputGeneratedError,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from 'ai'

type WrappableLanguageModel = Parameters<typeof wrapLanguageModel>[0]['model']
type AmaGenerateContent = Awaited<
  ReturnType<WrappableLanguageModel['doGenerate']>
>['content'][number]
type AmaStreamPart =
  Awaited<ReturnType<WrappableLanguageModel['doStream']>>['stream'] extends ReadableStream<
    infer Part
  >
    ? Part
    : never
type AmaFinishPart = Extract<AmaStreamPart, { type: 'finish' }>

const DEFAULT_EMPTY_COMPLETION_RETRIES = 1
const EMPTY_COMPLETION_ERROR_MESSAGE =
  'The inference model returned an empty completion after a semantic retry.'

function hasGeneratedContent(part: AmaGenerateContent): boolean {
  if (part.type === 'reasoning') {
    return false
  }

  return part.type !== 'text' || part.text.trim().length > 0
}

function hasStreamedContent(part: AmaStreamPart): boolean {
  if (part.type === 'text-delta') {
    return part.delta.trim().length > 0
  }

  return (
    part.type === 'tool-call' ||
    part.type === 'tool-result' ||
    part.type === 'tool-approval-request' ||
    part.type === 'file' ||
    part.type === 'source'
  )
}

function logEmptyCompletion(options: {
  model: WrappableLanguageModel
  attempt: number
  exhausted: boolean
  finishReason: string | undefined
  outputTokens: number | undefined
}) {
  console.warn(
    JSON.stringify({
      event: options.exhausted
        ? 'ama_empty_completion_retry_exhausted'
        : 'ama_empty_completion_retry',
      provider: options.model.provider,
      model: options.model.modelId,
      attempt: options.attempt,
      finishReason: options.finishReason,
      outputTokens: options.outputTokens,
    }),
  )
}

/**
 * Retries a provider response that successfully stops without producing user-
 * visible text or a tool call. Transport retries do not cover this case because
 * the provider returned HTTP 200 and a valid finish chunk.
 */
export function createAmaEmptyCompletionRetryMiddleware(
  maxRetries = DEFAULT_EMPTY_COMPLETION_RETRIES,
): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate, model }) => {
      let result = await doGenerate()

      for (let attempt = 0; ; attempt += 1) {
        if (result.content.some(hasGeneratedContent)) {
          return result
        }

        const canRetry = result.finishReason.unified === 'stop' && attempt < maxRetries
        if (!canRetry) {
          logEmptyCompletion({
            model,
            attempt: attempt + 1,
            exhausted: true,
            finishReason: result.finishReason.raw,
            outputTokens: result.usage.outputTokens.total,
          })
          throw new NoOutputGeneratedError({ message: EMPTY_COMPLETION_ERROR_MESSAGE })
        }

        logEmptyCompletion({
          model,
          attempt: attempt + 1,
          exhausted: false,
          finishReason: result.finishReason.raw,
          outputTokens: result.usage.outputTokens.total,
        })
        result = await doGenerate()
      }
    },
    wrapStream: async ({ doStream, model }) => {
      const initialResult = await doStream()
      let activeReader: ReadableStreamDefaultReader<AmaStreamPart> | undefined

      return {
        ...initialResult,
        stream: new ReadableStream<AmaStreamPart>({
          async start(controller) {
            let result = initialResult

            try {
              for (let attempt = 0; ; attempt += 1) {
                const bufferedParts: AmaStreamPart[] = []
                let hasContent = false
                let hasError = false
                let finishPart: AmaFinishPart | undefined
                activeReader = result.stream.getReader()

                while (true) {
                  const { done, value } = await activeReader.read()
                  if (done) {
                    break
                  }

                  if (value.type === 'finish') {
                    finishPart = value
                  }

                  if (value.type === 'error') {
                    hasError = true
                  }

                  if (!hasContent) {
                    bufferedParts.push(value)
                    hasContent = hasStreamedContent(value) || hasError

                    if (hasContent) {
                      for (const bufferedPart of bufferedParts) {
                        controller.enqueue(bufferedPart)
                      }
                    }
                    continue
                  }

                  controller.enqueue(value)
                }

                if (hasContent) {
                  controller.close()
                  return
                }

                // Preserve incomplete streams so the AI SDK can classify them
                // separately from the successful-but-empty response handled here.
                if (!finishPart) {
                  for (const bufferedPart of bufferedParts) {
                    controller.enqueue(bufferedPart)
                  }
                  controller.close()
                  return
                }

                const canRetry = finishPart.finishReason.unified === 'stop' && attempt < maxRetries
                if (!canRetry) {
                  logEmptyCompletion({
                    model,
                    attempt: attempt + 1,
                    exhausted: true,
                    finishReason: finishPart.finishReason.raw,
                    outputTokens: finishPart.usage.outputTokens.total,
                  })
                  controller.enqueue({
                    type: 'error',
                    error: new NoOutputGeneratedError({
                      message: EMPTY_COMPLETION_ERROR_MESSAGE,
                    }),
                  })
                  controller.close()
                  return
                }

                logEmptyCompletion({
                  model,
                  attempt: attempt + 1,
                  exhausted: false,
                  finishReason: finishPart.finishReason.raw,
                  outputTokens: finishPart.usage.outputTokens.total,
                })
                result = await doStream()
              }
            } catch (error) {
              controller.error(error)
            }
          },
          cancel(reason) {
            return activeReader?.cancel(reason)
          },
        }),
      }
    },
  }
}

export function withAmaInferenceReliability(model: LanguageModel): LanguageModel {
  if (typeof model === 'string' || model.specificationVersion !== 'v3') {
    return model
  }

  return wrapLanguageModel({
    model,
    middleware: createAmaEmptyCompletionRetryMiddleware(),
  })
}
