import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import {
  AMA_CONTEXT_TOOL_NAMES,
  describeAmaSourceResult,
  getAmaSourceDecision,
  getAmaSourceLedger,
  getAmaSourcePlan,
  type AmaContextToolName,
  type AmaSourceStep,
} from '@/lib/ama-source-policy'

const messages = (content: string): ModelMessage[] => [{ role: 'user', content }]
function completed(
  name: AmaContextToolName,
  output: unknown = { available: true, source: 'blob', content: 'PRIVATE_EVIDENCE' },
): AmaSourceStep {
  return {
    toolCalls: [{ toolName: name, toolCallId: name }],
    toolResults: [{ toolName: name, toolCallId: name, output }],
  }
}
const educationTools = ['get_public_site_content', 'get_resume']

describe('conservative AMA source plans', () => {
  it.each([
    'Where did you go to school?',
    'Where did you go to grad school?',
    'Where did you go to graduate school?',
    'Where did you go to undergrad college?',
    'What years did you attend each of your schools?',
    'Which years did you attend your universities?',
    'Which university did Jonathan Segovia attend?',
    'What degrees do you have?',
    'Tell me about your academic background.',
    'When did you graduate?',
    'Have you won any awards in your career?',
    'Which certifications do you have?',
    'Beyond those, what else is in your toolbox?',
    'Tell me about your qualifications.',
  ])('requires public then resume for %s', (question) => {
    expect(getAmaSourcePlan(messages(question)).requiredTools).toEqual(educationTools)
  })

  it.each([
    'Where did Ada Lovelace study?',
    'Build me a school website.',
    'What did you study to build that database?',
    'Which school did you build the dashboard for?',
    'How does your school project work?',
    'How does your friend Ada design systems at work?',
    'Translate "Where did you go to school?" into French.',
    'Do not discuss your education.',
    'Where did I go to college?',
    'Where did I go to grad school?',
    'What years did your friend attend each of your schools?',
    'What years did you attend school project demos?',
    'What years did you attend conferences?',
    'Translate "What years did you attend each of your schools?" into French.',
    'Do not discuss where you went to grad school.',
    'Do not answer: what years did you attend each of your schools?',
    'What side projects have I built?',
    'Translate "What side projects have you built?" into French.',
    'Do not list your side projects.',
    'Where was that?',
    'Have I won any awards?',
    'Does your colleague have certifications?',
    'Translate "What else is in your toolbox?" into French.',
  ])('leaves ambiguous, quoted, visitor and third-party intents adaptive: %s', (question) => {
    expect(getAmaSourcePlan(messages(question)).requiredTools).toEqual([])
  })

  it.each([
    ['How did you build your side project?', ['search_personal_context']],
    ['How does your side project work?', ['search_personal_context']],
    [
      'Do not discuss your education; explain your side project architecture.',
      ['search_personal_context'],
    ],
    ['Describe your professional work architecture.', ['search_work_context']],
    [
      'Compare recovery in your work and side project.',
      ['search_work_context', 'search_personal_context'],
    ],
    [
      'Where did you study, and how did you build your side project?',
      [...educationTools, 'search_personal_context'],
    ],
    [
      'How did you build your side project, and link its repository?',
      ['get_public_site_content', 'search_personal_context'],
    ],
  ])('plans %s', (question, tools) => {
    expect(getAmaSourcePlan(messages(question as string)).requiredTools).toEqual(tools)
  })

  it.each([
    'What side projects have you built?',
    'Which personal projects did you create?',
    'What hobby projects have you worked on?',
    'List your side projects.',
  ])('obtains a public inventory without forcing technical retrieval: %s', (question) => {
    const prompt = messages(question)
    expect(getAmaSourcePlan(prompt).requiredTools).toEqual(['get_public_site_content'])
    expect(getAmaSourceDecision(prompt, [], [...AMA_CONTEXT_TOOL_NAMES])).toMatchObject({
      activeTools: ['get_public_site_content'],
      forcedTool: 'get_public_site_content',
    })
    expect(
      getAmaSourceDecision(
        prompt,
        [completed('get_public_site_content')],
        ['get_resume', 'search_work_context', 'search_personal_context'],
      ).activeTools,
    ).toEqual([])
    expect(
      getAmaSourceDecision(
        prompt,
        [completed('search_personal_context')],
        ['get_public_site_content'],
      ).forcedTool,
    ).toBe('get_public_site_content')
  })

  it.each([
    'What side projects have you built? How do they handle recovery?',
    'What side projects have you built, and explain their architecture?',
  ])('keeps additional inventory details adaptive after public content: %s', (question) => {
    const prompt = messages(question)
    expect(getAmaSourcePlan(prompt)).toMatchObject({
      requiredTools: ['get_public_site_content'],
      allowAdditionalSources: true,
    })
    expect(
      getAmaSourceDecision(
        prompt,
        [completed('get_public_site_content')],
        ['search_personal_context'],
      ).activeTools,
    ).toEqual(['search_personal_context'])
  })

  it.each([
    [
      'List your side projects. Explain how your side project handles recovery.',
      ['get_public_site_content', 'search_personal_context'],
    ],
    [
      'What side projects have you built? Describe your professional work architecture.',
      ['get_public_site_content', 'search_work_context'],
    ],
    ['What side projects have you built, and where did you go to grad school?', educationTools],
  ])('preserves distinct requested sources alongside an inventory: %s', (question, tools) => {
    expect(getAmaSourcePlan(messages(question as string)).requiredTools).toEqual(tools)
  })

  it.each(['Where did you go to grad school?', 'What years did you attend each of your schools?'])(
    'requires the actual resume result before completing education: %s',
    (question) => {
      const prompt = messages(question)
      expect(getAmaSourceDecision(prompt, [], [...AMA_CONTEXT_TOOL_NAMES]).forcedTool).toBe(
        'get_public_site_content',
      )
      expect(
        getAmaSourceDecision(prompt, [completed('get_public_site_content')], ['get_resume'])
          .forcedTool,
      ).toBe('get_resume')
      expect(
        getAmaSourceDecision(
          prompt,
          [completed('get_public_site_content'), completed('get_resume')],
          ['search_work_context', 'search_personal_context'],
        ).activeTools,
      ).toEqual([])
    },
  )

  it('uses the latest user text parts without inheriting earlier education instructions', () => {
    expect(
      getAmaSourcePlan([
        ...messages('Where did you study?'),
        { role: 'assistant', content: 'My education. PRIVATE_OLD_ANSWER' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'How did you build' },
            { type: 'text', text: 'your side project?' },
          ],
        },
      ]).requiredTools,
    ).toEqual(['search_personal_context'])
  })

  it.each([
    'Compare your work at Acme with Quartz Ledger.',
    'Where did you study, and how did you build Quartz Ledger?',
    'Describe your work architecture and the implementation of your website.',
    'How do your work systems handle failures, and how does Cedar Notes recover offline?',
    'Describe your work architecture. Then explain how you built this website.',
    'Tell me about your education. Explain how you built this website.',
  ])('does not prematurely close a partially understood mixed request: %s', (question) => {
    const decision = getAmaSourceDecision(
      messages(question),
      [
        completed('get_public_site_content'),
        completed('get_resume'),
        completed('search_work_context'),
      ],
      ['search_personal_context'],
    )
    expect(decision.activeTools).toContain('search_personal_context')
  })

  it('still obtains requested public links after adaptively identifying a personal project', () => {
    const question = messages('How did you build Quartz Ledger, and link its repository?')
    const steps = [completed('search_personal_context')]
    expect(getAmaSourceDecision(question, steps, ['get_public_site_content'])).toMatchObject({
      activeTools: ['get_public_site_content'],
      forcedTool: 'get_public_site_content',
    })
    expect(
      getAmaSourceDecision(
        question,
        [...steps, completed('get_public_site_content')],
        ['search_work_context'],
      ).activeTools,
    ).toEqual([])
  })

  it('does not force a required tool excluded by custom step restrictions', () => {
    const decision = getAmaSourceDecision(messages('Where did you study?'), [], [])
    expect(decision.forcedTool).toBeUndefined()
    expect(decision.reminder).toContain('Required source still pending: public_site')
    expect(decision.reminder).not.toContain('public_site: unavailable')
  })

  it('completes a project architecture and public-link request after both sources', () => {
    const prompt = messages(
      'How did you build one of your personal projects? Explain the architecture and give a public link if one is available.',
    )
    expect(
      getAmaSourceDecision(
        prompt,
        [completed('get_public_site_content')],
        ['search_personal_context'],
      ).forcedTool,
    ).toBe('search_personal_context')
    expect(
      getAmaSourceDecision(
        prompt,
        [completed('get_public_site_content'), completed('search_personal_context')],
        ['get_resume', 'search_work_context'],
      ).activeTools,
    ).toEqual([])
  })

  it.each(['search_work_context', 'search_personal_context'] as const)(
    'checks public context after an adaptive %s no-match before falling back',
    (name) => {
      const prompt = messages('What did you work on at Example Company?')
      const steps = [
        completed(name, {
          available: false,
          source: 'no_matches',
          content: 'No matching evidence.',
        }),
      ]
      expect(getAmaSourceDecision(prompt, steps, ['get_public_site_content']).forcedTool).toBe(
        'get_public_site_content',
      )
      expect(
        getAmaSourceDecision(
          prompt,
          [...steps, completed('get_public_site_content')],
          ['get_resume'],
        ).activeTools,
      ).toEqual([])
    },
  )
})

describe('AMA source evidence and execution permission', () => {
  it.each(AMA_CONTEXT_TOOL_NAMES)(
    'reinforces first-person writing after %s, including adaptive public-only answers',
    (name) => {
      const question = messages('Give me a short summary.')
      const steps = [completed(name)]
      const originalSteps = structuredClone(steps)
      const eligibleTools = AMA_CONTEXT_TOOL_NAMES.filter((toolName) => toolName !== name)
      const decision = getAmaSourceDecision(question, steps, eligibleTools)

      expect(decision.reminder).toContain(
        'Use first person (I, me, my) when describing my background or experience, even when the question refers to me by name.',
      )
      expect(decision.activeTools).toEqual(name === 'get_public_site_content' ? eligibleTools : [])
      expect(decision.forcedTool).toBeUndefined()
      expect(steps).toEqual(originalSteps)
      expect(question).toEqual(messages('Give me a short summary.'))
    },
  )

  it.each([
    [{ available: true, source: 'blob', content: 'A brief supported fact.' }, 'found'],
    [{ available: false, source: 'no_matches', content: 'No matching context.' }, 'no_match'],
    [
      { available: false, source: 'blob_fetch_failed', content: 'Please see Projects.' },
      'unavailable',
    ],
    [{ available: true, source: 'blob', content: '  ' }, 'empty'],
    [{ available: false, source: 'empty_blob', content: 'Please see Career.' }, 'empty'],
  ] as const)('distinguishes factual text from unavailable fallback text', (result, status) => {
    expect(describeAmaSourceResult('search_personal_context', result)).toMatchObject({
      sourceKind: 'personal',
      retrievalStatus: status,
      available: status === 'found',
      content: result.content,
    })
  })

  it('keeps found evidence after a rejected repeat and enters the terminal answer stage', () => {
    const rejected = completed('search_personal_context', {
      available: false,
      source: 'blob_fetch_failed',
      content: 'PRIVATE_ERROR',
    })
    rejected.toolCalls[0]!.invalid = true
    const steps = [completed('search_personal_context'), rejected]
    expect(getAmaSourceLedger(steps).get('search_personal_context')).toBe('found')
    const decision = getAmaSourceDecision(messages('How did you build Quartz Ledger?'), steps, [
      'get_public_site_content',
      'search_work_context',
    ])
    expect(decision.activeTools).toEqual([])
    expect(decision.reminder).toContain('Source personal: found. Further calls allowed: no.')
    expect(decision.reminder).toContain('personal notes are not public website content')
    expect(decision.reminder).not.toContain('PRIVATE_')
  })

  it('retains the normalized empty status after wrapping and consuming a result', () => {
    const output = describeAmaSourceResult('get_resume', {
      available: true,
      source: 'blob',
      content: ' ',
    })
    expect(output.available).toBe(false)
    expect(getAmaSourceLedger([completed('get_resume', output)]).get('get_resume')).toBe('empty')
  })

  it('keeps found work evidence restricted even alongside found personal notes', () => {
    const decision = getAmaSourceDecision(
      messages('Compare recovery in your work and side project.'),
      [completed('search_work_context'), completed('search_personal_context')],
      [],
    )
    expect(decision.reminder).toContain('Source work: found')
    expect(decision.reminder).toContain('not permission to call again or permission to disclose it')
    expect(decision.reminder).toContain('FOUND work context remains restricted')
    expect(decision.reminder).toContain('anonymous, high-level summaries')
    expect(decision.reminder).toContain(
      'customers or other customer identifiers, internal codenames, internal dates, numbers, or implementation details',
    )
    expect(decision.reminder).toContain('finding work evidence does not make it disclosable')
    expect(decision.reminder).toContain(
      'Use supported facts from found public website, resume, and personal-project context',
    )
    expect(decision.reminder).toContain('without claiming the found notes are inaccessible')
    expect(decision.reminder).not.toContain('Use its supported facts')
    expect(decision.reminder).not.toContain('PRIVATE_EVIDENCE')
  })

  it('does not apply the unrestricted-found instruction to work-only evidence', () => {
    const decision = getAmaSourceDecision(
      messages('Describe your work architecture.'),
      [completed('search_work_context')],
      [],
    )
    expect(decision.reminder).toContain('FOUND work context remains restricted')
    expect(decision.reminder).not.toContain('Use supported facts from found')
  })

  it('consumes an actual execution error but ignores a rejected error', () => {
    const step: AmaSourceStep = {
      toolCalls: [{ toolName: 'get_public_site_content', toolCallId: 'public' }],
      content: [{ type: 'tool-error', toolName: 'get_public_site_content', toolCallId: 'public' }],
    }
    expect(
      getAmaSourceDecision(messages('Where did you study?'), [step], ['get_resume']),
    ).toMatchObject({ forcedTool: 'get_resume' })
    step.toolCalls[0]!.invalid = true
    expect(getAmaSourceLedger([step]).size).toBe(0)
  })

  it('does not invent evidence from accepted calls, forged IDs, or malformed results', () => {
    const mismatch = completed('get_resume')
    mismatch.toolResults![0]!.toolCallId = 'unmatched'
    expect(
      getAmaSourceLedger([
        { toolCalls: [{ toolName: 'get_resume', toolCallId: 'attempt-only' }] },
        mismatch,
        completed('search_work_context', {
          available: true,
          content: null,
          source: 'PRIVATE_SOURCE',
        }),
      ]).size,
    ).toBe(0)
  })

  it('a new turn has no evidence merely because the previous turn had retrieval', () => {
    const current = [
      ...messages('Where did you study?'),
      { role: 'assistant' as const, content: 'I studied computing.' },
      ...messages('How did you build Quartz Ledger?'),
    ]
    expect(getAmaSourceDecision(current, [], [...AMA_CONTEXT_TOOL_NAMES]).activeTools).toEqual(
      AMA_CONTEXT_TOOL_NAMES,
    )
  })
})
