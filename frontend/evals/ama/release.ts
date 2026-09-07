import frozen from './final-release.json'
import { sha256 } from './hashes'
import type { AmaEvalCase, AmaEvalFixtureProfile } from './types'
import type { AmaContextSearchResult } from '@/lib/ama-context'
import type { CreateAmaAgentOptions } from '@/lib/ama-agent'

export const FINAL_RELEASE_DATASET_SHA256 =
  '562666316ce39a665b07332e4aa11eb77892bdefde563afd453f3032e2a5717b'
export const finalReleaseDataset = frozen.cases as AmaEvalCase[]

export function assertFrozenFinalSuite(): void {
  if (sha256(frozen) !== FINAL_RELEASE_DATASET_SHA256) {
    throw new Error(
      'Final release suite changed after freezing. Create a separately versioned suite before any new selection run.',
    )
  }
}

type Dependencies = Pick<
  CreateAmaAgentOptions,
  'getPublicSiteContent' | 'getResumeContext' | 'searchWorkContext' | 'searchPersonalContext'
>

export function getFinalFixtureDependencies(profile: AmaEvalFixtureProfile): Dependencies {
  async function search(
    query: string,
    documents: typeof frozen.work,
  ): Promise<AmaContextSearchResult> {
    const matches =
      profile === 'context_unavailable'
        ? []
        : documents.filter((document) =>
            document.keywords.some((keyword) => query.toLowerCase().includes(keyword)),
          )
    return {
      available: matches.length > 0,
      source:
        profile === 'context_unavailable' ? 'list_failed' : matches.length ? 'blob' : 'no_matches',
      query,
      matches: matches.map((document) => ({
        pathname: document.pathname,
        uploadedAt: frozen.frozen_at,
        size: document.content.length,
        score: 1,
        excerpt: document.content,
      })),
      content: matches.length
        ? matches.map((document) => document.content).join('\n\n')
        : 'No matching AMA context was found for that question.',
    }
  }
  return {
    getPublicSiteContent: async () => {
      if (profile === 'public_unavailable') {
        throw new Error('Synthetic public context unavailable')
      }
      return {
        ...frozen.public,
        projects: frozen.public.projects.map((project) => ({
          ...project,
          githubUrl: project.githubUrl ?? '',
        })),
      }
    },
    getResumeContext: async () =>
      profile === 'context_unavailable'
        ? { available: false, source: 'missing_blob', content: '' }
        : { available: true, source: 'blob', content: frozen.resume },
    searchWorkContext: (query) => search(query, frozen.work),
    searchPersonalContext: (query) => search(query, frozen.personal),
  }
}
