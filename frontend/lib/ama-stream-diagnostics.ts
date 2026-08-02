import type { UIMessage } from 'ai'

export function summarizeAmaUiMessage(message: UIMessage) {
  const text = message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')

  return {
    id: message.id,
    role: message.role,
    partTypes: message.parts.map((part) => part.type),
    textLength: text.length,
    trimmedTextLength: text.trim().length,
  }
}

export function getAmaStreamErrorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}
