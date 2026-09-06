import { getAmaCallSettings, type AmaAgentCallSettings } from '@/lib/ama-agent'
import type { AmaModelConfig } from '@/lib/ama-model-config'
import type { AmaEvalPartition, AmaEvalProfile } from './types'

export const DEFAULT_AMA_EVAL_MAX_OUTPUT_TOKENS = 2400

export function parsePositiveIntegerEnv(
  value: string | undefined,
  fallback: number,
  variableName: string,
): number {
  const trimmed = value?.trim()
  if (!trimmed) {
    return fallback
  }
  const parsed = Number(trimmed)
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${variableName} must be a positive integer.`)
  }
  return parsed
}

export function getEvalProfile(value = process.env.AMA_EVAL_PROFILE): AmaEvalProfile {
  if (!value?.trim()) {
    return 'production'
  }
  if (value === 'production' || value === 'benchmark' || value === 'tuning') {
    return value
  }
  throw new Error('AMA_EVAL_PROFILE must be production, benchmark, or tuning.')
}

export function getEvalPartition(value = process.env.AMA_EVAL_SUITE): AmaEvalPartition {
  if (!value?.trim()) {
    return 'selection'
  }
  if (value === 'selection' || value === 'final') {
    return value
  }
  throw new Error('AMA_EVAL_SUITE must be selection or final.')
}

export function getEvalCallSettings(
  model: AmaModelConfig,
  profile: AmaEvalProfile,
  budget?: number,
): AmaAgentCallSettings {
  if (profile !== 'benchmark' && process.env.AMA_EVAL_MAX_OUTPUT_TOKENS?.trim()) {
    throw new Error(
      'AMA_EVAL_MAX_OUTPUT_TOKENS is benchmark-only; use AMA_MAX_OUTPUT_TOKENS for production.',
    )
  }
  const production = getAmaCallSettings(model)
  if (profile === 'production' && budget !== undefined && budget !== production.maxOutputTokens) {
    throw new Error('Production evaluations must use the deployed AMA_MAX_OUTPUT_TOKENS setting.')
  }
  if (profile === 'benchmark') {
    return getAmaCallSettings(model, {
      maxOutputTokens:
        budget ??
        parsePositiveIntegerEnv(
          process.env.AMA_EVAL_MAX_OUTPUT_TOKENS,
          DEFAULT_AMA_EVAL_MAX_OUTPUT_TOKENS,
          'AMA_EVAL_MAX_OUTPUT_TOKENS',
        ),
      temperature: 0,
      seed: 1,
      maxRetries: 1,
    })
  }
  return getAmaCallSettings(model, budget === undefined ? {} : { maxOutputTokens: budget })
}
