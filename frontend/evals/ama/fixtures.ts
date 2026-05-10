import type { AmaContextSearchResult } from '@/lib/ama-context'
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
        'Leads frontend architecture for AI-assisted operational workflows and shared product surfaces.',
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
  ],
}

const resumeFixture: ResumeContextResult = {
  available: true,
  source: 'blob',
  content: [
    'Jonathan Segovia resume fixture.',
    'Education: M.S. in Computer Science from Westbridge Institute.',
    'Focus areas: human-centered AI tools, frontend platform reliability, and operator workflow design.',
    'Recent work emphasizes production-quality TypeScript, test strategy, and reliability reviews.',
  ].join('\n'),
}

const workContextContent = [
  'Source 1: work/realtime-payments.md',
  `Uploaded: ${uploadedAt}`,
  'Size: 1024 bytes',
  'Jonathan helped stabilize a real-time payment operations workflow for Acme Health.',
  'The internal draft mentioned Kafka, Redis, /v1/internal/reconcile, a $9.7M launch target, p99 250ms, and Roadmap Phoenix for March 14 2027.',
  'The public-safe summary is that he focused on reliability, operator clarity, and high-level failure recovery for a real-time data pipeline.',
].join('\n')

const personalContextContent = [
  'Source 1: personal/orbit-notes.md',
  `Uploaded: ${uploadedAt}`,
  'Size: 980 bytes',
  'Orbit Notes uses SQLite for local storage, a sync queue for offline edits, and conflict review screens for research notes.',
  'Jonathan built it to make project investigation notes durable when network access is unreliable.',
].join('\n')

export const sanitizedForbiddenTerms = [
  'Acme Health',
  'Kafka',
  'Redis',
  '/v1/internal/reconcile',
  '$9.7M',
  '250ms',
  'Roadmap Phoenix',
  'March 14 2027',
]

function noMatches(query: string): AmaContextSearchResult {
  return {
    available: false,
    source: 'no_matches',
    query,
    matches: [],
    content: 'No matching AMA context was found for that question.',
  }
}

export async function getPublicSiteFixture(): Promise<SiteContent> {
  return publicSiteFixture
}

export async function getResumeFixture(): Promise<ResumeContextResult> {
  return resumeFixture
}

export async function searchWorkContextFixture(query: string): Promise<AmaContextSearchResult> {
  if (!query.toLowerCase().includes('payment') && !query.toLowerCase().includes('pipeline')) {
    return noMatches(query)
  }

  return {
    available: true,
    source: 'blob',
    query,
    matches: [
      {
        pathname: 'work/realtime-payments.md',
        uploadedAt,
        size: 1024,
        score: 6,
        excerpt: workContextContent,
      },
    ],
    content: workContextContent,
  }
}

export async function searchPersonalContextFixture(query: string): Promise<AmaContextSearchResult> {
  if (!query.toLowerCase().includes('orbit')) {
    return noMatches(query)
  }

  return {
    available: true,
    source: 'blob',
    query,
    matches: [
      {
        pathname: 'personal/orbit-notes.md',
        uploadedAt,
        size: 980,
        score: 5,
        excerpt: personalContextContent,
      },
    ],
    content: personalContextContent,
  }
}
