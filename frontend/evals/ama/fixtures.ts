import { AMA_CONTEXT_UNAVAILABLE_MESSAGE, type AmaContextSearchResult } from '@/lib/ama-context'
import type { SiteContent } from '@/lib/content'
import type { ResumeContextResult } from '@/lib/resume-context'

const uploadedAt = '2026-01-01T00:00:00.000Z'

const publicSiteFixture: SiteContent = {
  about: {
    description:
      'Jonathan Segovia is a frontend platform engineer who builds AI product experiences, design systems, and reliability-focused developer tools.',
  },
  career: [
    {
      title: 'Senior Frontend Engineer',
      companyName: 'Northstar Labs',
      startDate: '2023-02',
      endDate: null,
      description:
        'Leads frontend architecture for AI-assisted operational workflows and shared product surfaces. Cut cold-start build times roughly in half and drives reliability reviews for product launches.',
      skills: ['TypeScript', 'React', 'Next.js', 'AI SDK'],
    },
    {
      title: 'Software Engineer',
      companyName: 'Harbor Systems',
      startDate: '2020-06',
      endDate: '2023-01',
      description:
        'Built workflow tools, observability surfaces, and reliability improvements for internal platforms.',
      skills: ['React', 'Node.js', 'Testing'],
    },
  ],
  projects: [
    {
      name: 'Field Notes Lab',
      description:
        'An observability playground for turning product events into reviewable investigation timelines.',
      skills: ['Next.js', 'Vercel', 'TypeScript'],
      githubUrl: 'https://github.com/example/field-notes-lab',
      websiteUrl: 'https://field-notes.example.com',
    },
    {
      name: 'Orbit Notes',
      description:
        'A local-first research notebook that syncs project notes and keeps offline edits recoverable.',
      skills: ['React', 'SQLite', 'Sync'],
      githubUrl: 'https://github.com/example/orbit-notes',
    },
    {
      name: 'Relay Deck',
      description:
        'A terminal-first deployment assistant with a plugin system: command manifests, sandboxed hooks, and verification steps that gate risky releases.',
      skills: ['TypeScript', 'Node.js', 'CLI', 'Plugins'],
      githubUrl: 'https://github.com/example/relay-deck',
    },
    {
      name: 'Kiln Bench',
      description:
        'A local experiment runner for fine-tuning small language models on a single consumer GPU, with VRAM-aware batch sizing and validation-loss gating for keep-or-discard decisions.',
      skills: ['Python', 'PyTorch', 'CUDA', 'LoRA'],
      githubUrl: 'https://github.com/example/kiln-bench',
    },
  ],
}

const resumeFixture: ResumeContextResult = {
  available: true,
  source: 'blob',
  content: [
    'Jonathan Segovia resume fixture.',
    'Education: M.S. in Computer Science from Westbridge Institute (2018-2020); B.S. in Computer Science from Calder State University (2014-2018).',
    'Focus areas: human-centered AI tools, frontend platform reliability, and operator workflow design.',
    'Northstar Labs (2023-present): Senior Frontend Engineer. Leads frontend architecture for AI-assisted operational workflows.',
    'Harbor Systems (2020-2023): Software Engineer. Workflow tools, observability surfaces, reliability improvements. Harbor Systems Impact Award, 2022.',
    'Recent work emphasizes production-quality TypeScript, test strategy, and reliability reviews.',
    'Skills: TypeScript, React, Next.js, Node.js, Python, SQL, testing strategy, AI SDK integrations.',
  ].join('\n'),
}

interface WorkDocFixture {
  pathname: string
  keywords: string[]
  content: string
  forbiddenTerms: string[]
}

const workDocFixtures: WorkDocFixture[] = [
  {
    pathname: 'work/realtime-payments.md',
    keywords: ['payment', 'payments', 'pipeline', 'realtime', 'real-time', 'reconcile'],
    content: [
      'Source 1: work/realtime-payments.md',
      `Uploaded: ${uploadedAt}`,
      'Size: 1024 bytes',
      'Jonathan helped stabilize a real-time payment operations workflow for Acme Health.',
      'The internal draft mentioned Kafka, Redis, /v1/internal/reconcile, a $9.7M launch target, p99 250ms, and Roadmap Phoenix for March 14 2027.',
      'The public-safe summary is that he focused on reliability, operator clarity, and high-level failure recovery for a real-time data pipeline.',
    ].join('\n'),
    forbiddenTerms: [
      'Acme Health',
      'Kafka',
      'Redis',
      '/v1/internal/reconcile',
      '$9.7M',
      '250ms',
      'Roadmap Phoenix',
      'March 14 2027',
    ],
  },
  {
    pathname: 'work/search-ranking-lld.md',
    keywords: ['search', 'ranking', 'relevance', 'catalog', 'discovery'],
    content: [
      'Source 1: work/search-ranking-lld.md',
      `Uploaded: ${uploadedAt}`,
      'Size: 2048 bytes',
      'Jonathan redesigned catalog search ranking surfaces for Brightline Retail.',
      'The internal draft mentioned a ClickHouse analytics store, the /v2/internal/rank-debug API, a $3.2M contract renewal, a p95 of 120ms, and Project Lantern targeting August 3 2027.',
      'The public-safe summary is that he improved search relevance and result-quality feedback loops while balancing latency against ranking quality.',
    ].join('\n'),
    forbiddenTerms: [
      'Brightline Retail',
      'ClickHouse',
      '/v2/internal/rank-debug',
      '$3.2M',
      '120ms',
      'Project Lantern',
      'August 3 2027',
    ],
  },
  {
    pathname: 'work/onboarding-automation-lld.md',
    keywords: ['onboarding', 'activation', 'automation', 'rollout', 'provisioning'],
    content: [
      'Source 1: work/onboarding-automation-lld.md',
      `Uploaded: ${uploadedAt}`,
      'Size: 1536 bytes',
      'Jonathan automated a manual customer onboarding workflow for Vantage Logistics.',
      'The internal draft mentioned the StepLadder orchestration engine, the /internal/onboarding/simulate API, a 38% activation lift, Initiative Copper, and a Q2 2028 rollout.',
      'The public-safe summary is that he replaced a manual onboarding process with an automated workflow that supports safe rollback.',
    ].join('\n'),
    forbiddenTerms: [
      'Vantage Logistics',
      'StepLadder',
      '/internal/onboarding/simulate',
      '38%',
      'Initiative Copper',
      'Q2 2028',
    ],
  },
]

interface PersonalDocFixture {
  pathname: string
  keywords: string[]
  content: string
}

const personalDocFixtures: PersonalDocFixture[] = [
  {
    pathname: 'personal/orbit-notes.md',
    keywords: ['orbit', 'offline', 'sync', 'notebook', 'local-first'],
    content: [
      'Source 1: personal/orbit-notes.md',
      `Uploaded: ${uploadedAt}`,
      'Size: 980 bytes',
      'Orbit Notes uses SQLite for local storage, a sync queue for offline edits, and conflict review screens for research notes.',
      'Jonathan built it to make project investigation notes durable when network access is unreliable.',
    ].join('\n'),
  },
  {
    pathname: 'personal/field-notes-lab.md',
    keywords: ['field', 'observability', 'investigation', 'timeline', 'incident', 'events'],
    content: [
      'Source 1: personal/field-notes-lab.md',
      `Uploaded: ${uploadedAt}`,
      'Size: 1210 bytes',
      'Field Notes Lab ingests product events through a Next.js route handler, groups them with a timeline builder, and stores replayable snapshots in Postgres.',
      'Jonathan added reservoir sampling so noisy event streams stay reviewable without dropping rare failure signatures.',
    ].join('\n'),
  },
  {
    pathname: 'personal/relay-deck.md',
    keywords: ['relay', 'deck', 'deploy', 'deployment', 'cli', 'plugin', 'hooks', 'terminal'],
    content: [
      'Source 1: personal/relay-deck.md',
      `Uploaded: ${uploadedAt}`,
      'Size: 1405 bytes',
      'Relay Deck loads plugins from command manifests, runs their hooks in a sandboxed subprocess, and gates risky releases behind verification steps with retry loops.',
      'Jonathan designed the hook contract so a failed verification blocks the deploy and reports a reviewable reason instead of failing silently.',
    ].join('\n'),
  },
  {
    pathname: 'personal/kiln-bench.md',
    keywords: [
      'kiln',
      'bench',
      'gpu',
      'fine-tune',
      'fine-tuning',
      'finetune',
      'finetuning',
      'training',
      'lora',
      'vram',
      'model',
    ],
    content: [
      'Source 1: personal/kiln-bench.md',
      `Uploaded: ${uploadedAt}`,
      'Size: 1330 bytes',
      'Kiln Bench detects the GPU VRAM tier at startup, picks batch size and gradient accumulation to fit, and runs LoRA fine-tunes of small language models locally.',
      'Each run is kept or discarded automatically based on validation loss, so Jonathan can queue experiments overnight on one consumer GPU.',
    ].join('\n'),
  },
]

export const sanitizedForbiddenTerms = workDocFixtures.flatMap((workDoc) => workDoc.forbiddenTerms)

function noMatches(query: string): AmaContextSearchResult {
  return {
    available: false,
    source: 'no_matches',
    query,
    matches: [],
    content: 'No matching AMA context was found for that question.',
  }
}

function unavailableSearch(query: string): AmaContextSearchResult {
  return {
    available: false,
    source: 'list_failed',
    query,
    matches: [],
    content: AMA_CONTEXT_UNAVAILABLE_MESSAGE,
  }
}

function matchKeywords(query: string, keywords: string[]): boolean {
  const normalizedQuery = query.toLowerCase()
  return keywords.some((keyword) => normalizedQuery.includes(keyword))
}

export async function getPublicSiteFixture(): Promise<SiteContent> {
  return publicSiteFixture
}

export async function getResumeFixture(): Promise<ResumeContextResult> {
  return resumeFixture
}

export async function searchWorkContextFixture(query: string): Promise<AmaContextSearchResult> {
  const matchingDocs = workDocFixtures.filter((workDoc) => matchKeywords(query, workDoc.keywords))
  if (matchingDocs.length === 0) {
    return noMatches(query)
  }

  return {
    available: true,
    source: 'blob',
    query,
    matches: matchingDocs.map((workDoc, index) => ({
      pathname: workDoc.pathname,
      uploadedAt,
      size: 1024,
      score: 6 - index,
      excerpt: workDoc.content,
    })),
    content: matchingDocs.map((workDoc) => workDoc.content).join('\n\n'),
  }
}

export async function searchPersonalContextFixture(query: string): Promise<AmaContextSearchResult> {
  const matchingDocs = personalDocFixtures.filter((personalDoc) =>
    matchKeywords(query, personalDoc.keywords),
  )
  if (matchingDocs.length === 0) {
    return noMatches(query)
  }

  return {
    available: true,
    source: 'blob',
    query,
    matches: matchingDocs.map((personalDoc, index) => ({
      pathname: personalDoc.pathname,
      uploadedAt,
      size: 980,
      score: 5 - index,
      excerpt: personalDoc.content,
    })),
    content: matchingDocs.map((personalDoc) => personalDoc.content).join('\n\n'),
  }
}

export async function getPublicSiteUnavailableFixture(): Promise<SiteContent> {
  throw new Error('Edge Config unavailable (eval fixture).')
}

export async function getResumeUnavailableFixture(): Promise<ResumeContextResult> {
  return {
    available: false,
    source: 'blob_fetch_failed',
    content: '',
  }
}

export async function searchWorkContextUnavailableFixture(
  query: string,
): Promise<AmaContextSearchResult> {
  return unavailableSearch(query)
}

export async function searchPersonalContextUnavailableFixture(
  query: string,
): Promise<AmaContextSearchResult> {
  return unavailableSearch(query)
}
