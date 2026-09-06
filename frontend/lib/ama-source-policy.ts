import type { ModelMessage } from 'ai'

export const AMA_CONTEXT_TOOL_NAMES = [
  'get_public_site_content',
  'get_resume',
  'search_work_context',
  'search_personal_context',
] as const

export type AmaContextToolName = (typeof AMA_CONTEXT_TOOL_NAMES)[number]
export type AmaRetrievalStatus = 'found' | 'no_match' | 'empty' | 'unavailable'
const SOURCE_KINDS = {
  get_public_site_content: 'public_site',
  get_resume: 'resume',
  search_work_context: 'work',
  search_personal_context: 'personal',
} as const

export function describeAmaSourceResult<
  T extends { available: boolean; content: string; source: string },
>(name: AmaContextToolName, result: T) {
  const retrievalStatus: AmaRetrievalStatus =
    result.available && result.content.trim()
      ? 'found'
      : result.source === 'no_matches'
        ? 'no_match'
        : result.available ||
            ['empty_blob', 'empty_files'].includes(result.source) ||
            ('retrievalStatus' in result && result.retrievalStatus === 'empty')
          ? 'empty'
          : 'unavailable'
  return {
    ...result,
    available: retrievalStatus === 'found',
    sourceKind: SOURCE_KINDS[name],
    retrievalStatus,
    executionStatus: 'executed' as const,
  }
}

export interface AmaSourcePlan {
  requiredTools: AmaContextToolName[]
  needsPublicLinks: boolean
  // An underspecified comparison remains model-routed instead of prematurely
  // closing the turn after its first private source.
  allowAdditionalSources: boolean
}

function latestUserText(messages: ModelMessage[]): string {
  const message = messages.findLast((item) => item.role === 'user')
  if (!message) {
    return ''
  }
  return typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' ')
}

export function getAmaSourcePlan(messages: ModelMessage[]): AmaSourcePlan {
  // Plan from this request, never earlier answers, tool text, or client claims
  // that a source has already been consulted. Quoted examples are not intents.
  const clauses = latestUserText(messages)
    .replace(/```[\s\S]*?```|`[^`]*`|"[^"]*"|“[^”]*”/g, ' ')
    .replace(/[’]/g, "'")
    .toLowerCase()
    .split(/[;.!?\n]+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .filter((clause) => !/\b(?:not|don't|never|avoid|without)\b/.test(clause))
    .filter(
      (clause) =>
        !/\byour (?:friend|colleague|coworker|manager|partner|brother|sister|parent)\b/.test(
          clause,
        ),
    )
  const text = clauses.join('. ')
  const subject = /\b(?:you|your|jonathan(?: segovia)?|segov)\b/.test(text)
  const education =
    /\b(?:your|jonathan(?: segovia)?'s|segov's) (?:education|academic background|educational background|degrees?|undergraduate|undergrad|master'?s|phd)\b/.test(
      text,
    ) ||
    /\bwhere (?:did|do) (?:you|jonathan(?: segovia)?|segov) (?:go to (?:school|college|university)|study|attend|graduate)\b/.test(
      text,
    ) ||
    /\b(?:what|which) (?:schools?|colleges?|universities|university|degrees?) (?:did|do|have) (?:you|jonathan(?: segovia)?|segov) (?:attend|graduate|study|earn|earned|receive|received|hold|have|go to)\b/.test(
      text,
    ) ||
    /\bwhen did (?:you|jonathan(?: segovia)?|segov) graduate\b/.test(text)
  const detail =
    /\b(?:how|architecture|implementation|design|storage|sync|recovery|offline|tradeoffs?|technical|internals?|built|build)\b/.test(
      text,
    )
  const personal =
    subject &&
    detail &&
    /\b(?:(?:side|personal|hobby)[- ]projects?|your work and personal)\b/.test(text) &&
    !/\b(?:my|their|her|his) (?:side|personal|hobby)[- ]projects?\b/.test(text)
  const work =
    subject &&
    detail &&
    /\b(?:your (?:professional )?(?:work|jobs?|employers?|workplace)|at work|work-related|professional (?:work|experience))\b/.test(
      text,
    )
  const links =
    /\b(?:links?|urls?|github|repositories|repository|career page|projects page)\b/.test(text)
  const requiredTools: AmaContextToolName[] = []
  if (education || (links && (personal || work))) {
    requiredTools.push('get_public_site_content')
  }
  if (education) {
    requiredTools.push('get_resume')
  }
  if (work) {
    requiredTools.push('search_work_context')
  }
  if (personal) {
    requiredTools.push('search_personal_context')
  }
  return {
    requiredTools,
    needsPublicLinks: links,
    allowAdditionalSources:
      (!(work && personal) && /\b(?:compare|comparison|versus|vs|both)\b/.test(text)) ||
      (!(work && personal) && (education || work || personal) && detail && clauses.length > 1) ||
      (!(work && personal) &&
        detail &&
        /\b(?:and|also|plus)\s+(?:the\s+|your\s+|its\s+)?(?:how|what|why|implementation|architecture|design|storage|sync|recovery)\b/.test(
          text,
        )),
  }
}

export interface AmaSourceStep {
  toolCalls: Array<{ toolCallId?: string; toolName: string; invalid?: boolean }>
  toolResults?: Array<{ toolCallId?: string; toolName: string; output: unknown }>
  content?: Array<{ type: string; toolCallId?: string; toolName?: string }>
}

export function getAmaSourceLedger(steps: AmaSourceStep[]) {
  const ledger = new Map<AmaContextToolName, AmaRetrievalStatus>()
  for (const step of steps) {
    for (const result of step.toolResults ?? []) {
      const name = AMA_CONTEXT_TOOL_NAMES.find((name) => name === result.toolName)
      if (
        !name ||
        !result.toolCallId ||
        !step.toolCalls.some(
          (call) =>
            !call.invalid && call.toolName === name && call.toolCallId === result.toolCallId,
        )
      ) {
        continue
      }
      const value = result.output
      if (
        !value ||
        typeof value !== 'object' ||
        !('available' in value) ||
        typeof value.available !== 'boolean' ||
        !('content' in value) ||
        typeof value.content !== 'string' ||
        !('source' in value) ||
        typeof value.source !== 'string'
      ) {
        continue
      }
      // A rejected later attempt must never overwrite earlier usable evidence.
      if (!ledger.has(name)) {
        ledger.set(
          name,
          describeAmaSourceResult(name, {
            available: value.available,
            content: value.content,
            source: value.source,
            ...('retrievalStatus' in value ? { retrievalStatus: value.retrievalStatus } : {}),
          }).retrievalStatus,
        )
      }
    }
    for (const error of step.content ?? []) {
      const name = AMA_CONTEXT_TOOL_NAMES.find((name) => name === error.toolName)
      if (
        error.type === 'tool-error' &&
        error.toolCallId &&
        name &&
        !ledger.has(name) &&
        step.toolCalls.some(
          (call) => !call.invalid && call.toolName === name && call.toolCallId === error.toolCallId,
        )
      ) {
        ledger.set(name, 'unavailable')
      }
    }
  }
  return ledger
}

export function getAmaSourceDecision(
  messages: ModelMessage[],
  steps: AmaSourceStep[],
  eligibleTools: AmaContextToolName[],
) {
  const plan = getAmaSourcePlan(messages)
  const ledger = getAmaSourceLedger(steps)
  // Adaptive routing can discover a named project's source. An explicitly
  // requested public link still requires public content after that discovery.
  if (
    plan.needsPublicLinks &&
    [...ledger.keys()].some((name) => name !== 'get_public_site_content') &&
    !plan.requiredTools.includes('get_public_site_content')
  ) {
    plan.requiredTools.push('get_public_site_content')
  }
  const pending = plan.requiredTools.filter((name) => !ledger.has(name))
  const requiredTool = pending[0]
  const privateCompleted = [...ledger.keys()].some((name) => name !== 'get_public_site_content')
  const terminal =
    pending.length === 0 &&
    !plan.allowAdditionalSources &&
    (privateCompleted || plan.requiredTools.length > 0)
  // Respect an upstream restriction. Do not force a source that prepareStep
  // explicitly excluded or pretend that excluded source returned no evidence.
  const forcedTool = requiredTool && eligibleTools.includes(requiredTool) ? requiredTool : undefined
  return {
    activeTools: terminal ? [] : forcedTool ? [forcedTool] : eligibleTools,
    forcedTool,
    reminder: [
      ...AMA_CONTEXT_TOOL_NAMES.flatMap((name) => {
        const status = ledger.get(name)
        return status ? [`Source ${SOURCE_KINDS[name]}: ${status}. Further calls allowed: no.`] : []
      }),
      ...(requiredTool
        ? [
            `Required source still pending: ${SOURCE_KINDS[requiredTool]}. It has not returned evidence yet.`,
          ]
        : []),
      ...(ledger.size
        ? [
            'Source status describes returned evidence, not permission to call again. FOUND evidence remains usable even after a later rejected call. Use its supported facts; acknowledge unspecified details without claiming the notes are inaccessible. Attribute facts to the source that returned them; personal notes are not public website content. Keep work disclosure restrictions in force.',
          ]
        : []),
    ].join('\n'),
  }
}
