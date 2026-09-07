import React from 'react'
import type { ComponentProps } from 'react'
import type * as StreamdownModule from 'streamdown'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AMAPage from '@/app/ama/page'

const {
  clearErrorMock,
  regenerateMock,
  sendMessageMock,
  setMessagesMock,
  stopMock,
  streamdownModes,
  toastMock,
  useChatMock,
} = vi.hoisted(() => ({
  clearErrorMock: vi.fn(),
  regenerateMock: vi.fn(),
  sendMessageMock: vi.fn(),
  setMessagesMock: vi.fn(),
  stopMock: vi.fn(),
  streamdownModes: [] as Array<'static' | 'streaming' | undefined>,
  toastMock: vi.fn(),
  useChatMock: vi.fn(),
}))

vi.mock('@ai-sdk/react', () => ({
  useChat: useChatMock,
}))

vi.mock('streamdown', async (importOriginal) => {
  const actual = await importOriginal<typeof StreamdownModule>()
  const { createElement } = await import('react')

  return {
    ...actual,
    Streamdown: (props: ComponentProps<typeof actual.Streamdown>) => {
      streamdownModes.push(props.mode)
      return createElement(actual.Streamdown, props)
    },
  }
})

vi.mock('@/components/navbar', () => ({
  Navbar: () => <div data-testid="navbar" />,
}))

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: toastMock,
  }),
}))

describe('AMA page', () => {
  const storageKey = 'segov-dev:ama:v1'
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    streamdownModes.length = 0
    const storage = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
        clear: () => storage.clear(),
      },
      configurable: true,
    })
    window.localStorage.clear()
    useChatMock.mockReturnValue({
      status: 'ready',
      error: undefined,
      clearError: clearErrorMock,
      regenerate: regenerateMock,
      sendMessage: sendMessageMock,
      setMessages: setMessagesMock,
      stop: stopMock,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'Error: Query outside permitted scope. This terminal only responds to questions about me, Jonathan Segovia.',
            },
          ],
        },
      ],
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    cleanup()
  })

  it('renders completed assistant output in static mode', () => {
    render(<AMAPage />)
    expect(
      screen.getByText(
        'Error: Query outside permitted scope. This terminal only responds to questions about me, Jonathan Segovia.',
      ),
    ).toBeInTheDocument()
    expect(streamdownModes).toContain('static')
    expect(streamdownModes).not.toContain('streaming')
  })

  it('throttles streamed chat updates to protect React from large SSE chunks', () => {
    render(<AMAPage />)

    expect(useChatMock).toHaveBeenCalledWith(expect.objectContaining({ experimental_throttle: 50 }))
  })

  it('uses Streamdown streaming mode only for the active assistant response', () => {
    useChatMock.mockReturnValue({
      status: 'streaming',
      error: undefined,
      clearError: clearErrorMock,
      regenerate: regenerateMock,
      sendMessage: sendMessageMock,
      setMessages: setMessagesMock,
      stop: stopMock,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Streaming response' }],
        },
      ],
    })

    render(<AMAPage />)

    expect(streamdownModes).toContain('streaming')
  })

  it('logs only sanitized client stream diagnostics', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<AMAPage />)

    const chatOptions = useChatMock.mock.calls[0]?.[0] as {
      onFinish?: (event: {
        message: {
          id: string
          role: 'assistant'
          parts: Array<{ type: 'text'; text: string }>
        }
        finishReason: 'stop'
        isAbort: boolean
        isDisconnect: boolean
        isError: boolean
      }) => void
      onError?: (error: Error) => void
    }
    chatOptions.onFinish?.({
      message: {
        id: 'assistant-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'private response text' }],
      },
      finishReason: 'stop',
      isAbort: false,
      isDisconnect: false,
      isError: false,
    })
    chatOptions.onError?.(new TypeError('Failed to fetch private browser response'))

    expect(infoSpy).toHaveBeenCalledTimes(1)
    expect(infoSpy.mock.calls[0]).toHaveLength(1)
    expect(JSON.parse(String(infoSpy.mock.calls[0]?.[0]))).toEqual({
      event: 'ama_client_ui_stream_finish',
      finishReason: 'stop',
      isAbort: false,
      isDisconnect: false,
      isError: false,
      message: {
        id: 'assistant-1',
        role: 'assistant',
        partTypes: ['text'],
        textLength: 21,
        trimmedTextLength: 21,
      },
    })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0]).toHaveLength(1)
    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual({
      event: 'ama_client_ui_stream_error',
      errorType: 'TypeError',
      errorKind: 'network',
      retryable: true,
    })
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain('private')
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('browser failure')

    infoSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it.each([
    [
      'length',
      'answer',
      {
        title: 'Response truncated',
        description: 'The response reached its length limit. Try a narrower question.',
      },
    ],
    [
      'content-filter',
      'partial answer',
      {
        title: 'Response filtered',
        description: 'The provider stopped this response. Try rephrasing your question.',
      },
    ],
    [
      'error',
      'partial answer',
      {
        title: 'Response interrupted',
        description: 'The model response could not be completed. Please retry.',
        variant: 'destructive',
      },
    ],
    [
      'stop',
      '   ',
      {
        title: 'No answer generated',
        description: 'The model did not produce a usable answer. Please retry.',
        variant: 'destructive',
      },
    ],
    [
      undefined,
      'partial answer',
      {
        title: 'Response interrupted',
        description: 'The response ended before its completion status arrived. Please retry.',
        variant: 'destructive',
      },
    ],
  ] as const)('explains the %s completion outcome', (finishReason, text, expectedToast) => {
    render(<AMAPage />)

    const chatOptions = useChatMock.mock.calls.at(-1)?.[0] as {
      onFinish?: (event: {
        message: {
          id: string
          role: 'assistant'
          parts: Array<{ type: 'text'; text: string }>
        }
        finishReason?: 'stop' | 'length' | 'content-filter' | 'error'
        isAbort: boolean
        isDisconnect: boolean
        isError: boolean
      }) => void
    }
    chatOptions.onFinish?.({
      message: {
        id: 'assistant-outcome',
        role: 'assistant',
        parts: [{ type: 'text', text }],
      },
      finishReason,
      isAbort: false,
      isDisconnect: false,
      isError: false,
    })

    expect(toastMock).toHaveBeenCalledWith(expectedToast)
  })

  it('does not report a user-initiated abort as an error', () => {
    render(<AMAPage />)

    const chatOptions = useChatMock.mock.calls.at(-1)?.[0] as {
      onFinish?: (event: {
        message: {
          id: string
          role: 'assistant'
          parts: Array<{ type: 'text'; text: string }>
        }
        finishReason?: 'stop'
        isAbort: boolean
        isDisconnect: boolean
        isError: boolean
      }) => void
    }
    chatOptions.onFinish?.({
      message: {
        id: 'assistant-aborted',
        role: 'assistant',
        parts: [{ type: 'text', text: 'partial answer' }],
      },
      isAbort: true,
      isDisconnect: false,
      isError: false,
    })

    expect(toastMock).not.toHaveBeenCalled()
  })

  it('shows the server-side storage and sensitive-information notice', () => {
    render(<AMAPage />)

    expect(
      screen.getByText(
        /Conversations are stored server-side and may be reviewed or used to improve this chatbot/,
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(/Do not submit sensitive personal information/)).toBeInTheDocument()
  })

  it('preserves assistant soft line breaks for terminal-style local messages', () => {
    useChatMock.mockReturnValue({
      status: 'ready',
      error: undefined,
      clearError: clearErrorMock,
      regenerate: regenerateMock,
      sendMessage: sendMessageMock,
      setMessages: setMessagesMock,
      stop: stopMock,
      messages: [
        {
          id: 'initial',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'segov@terminal:~$ ./ama \nAsk me anything about my work and projects.',
            },
          ],
        },
      ],
    })

    const { container } = render(<AMAPage />)

    expect(container.querySelector('.ama-markdown')).toHaveClass('whitespace-pre-line')
    expect(screen.getByText(/Ask me anything about my work and projects/)).toBeInTheDocument()
  })

  it('renders assistant markdown headings and bold text semantically', () => {
    useChatMock.mockReturnValue({
      status: 'ready',
      error: undefined,
      clearError: clearErrorMock,
      regenerate: regenerateMock,
      sendMessage: sendMessageMock,
      setMessages: setMessagesMock,
      stop: stopMock,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: '## Career\n\nJonathan builds **AI tools** for developers.',
            },
          ],
        },
      ],
    })

    render(<AMAPage />)

    expect(screen.getByRole('heading', { level: 2, name: 'Career' })).toBeInTheDocument()
    expect(screen.queryByText('## Career')).not.toBeInTheDocument()
    expect(screen.getByText('AI tools').closest('[data-streamdown="strong"]')).toBeInTheDocument()
    expect(screen.queryByText('**AI tools**')).not.toBeInTheDocument()
  })

  it('strips assistant markdown images and blocks unsafe link hrefs', () => {
    useChatMock.mockReturnValue({
      status: 'ready',
      error: undefined,
      clearError: clearErrorMock,
      regenerate: regenerateMock,
      sendMessage: sendMessageMock,
      setMessages: setMessagesMock,
      stop: stopMock,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: '![private](https://example.com/private.png)\n\n[bad link](javascript:alert(1))',
            },
          ],
        },
      ],
    })

    render(<AMAPage />)

    expect(screen.queryByRole('img', { name: 'private' })).not.toBeInTheDocument()
    const unsafeAnchor = screen.getByText(/bad link/).closest('a')
    expect(unsafeAnchor?.getAttribute('href') ?? '').not.toMatch(/^javascript:/i)
  })

  it('submits user prompt through useChat sendMessage', async () => {
    render(<AMAPage />)

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Tell me about your work.' } })
    fireEvent.submit(input.closest('form')!)

    expect(sendMessageMock).toHaveBeenCalledWith({ text: 'Tell me about your work.' })
  })

  it('names the prompt and announces completed responses without announcing streamed tokens', () => {
    const { rerender } = render(<AMAPage />)
    expect(screen.getByRole('textbox', { name: 'Ask a question' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    const chatState = useChatMock.mock.results.at(-1)?.value

    useChatMock.mockReturnValue({
      ...chatState,
      status: 'streaming',
      messages: [{ id: 'answer', role: 'assistant', parts: [{ type: 'text', text: 'Partial' }] }],
    })
    rerender(<AMAPage />)
    expect(screen.getByRole('region', { name: 'Conversation' })).toHaveTextContent('Partial')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()

    const onFinish = useChatMock.mock.calls.at(-1)?.[0].onFinish
    act(() => {
      onFinish({
        message: {
          id: 'answer',
          role: 'assistant',
          parts: [{ type: 'text', text: 'The completed answer.' }],
        },
        finishReason: 'stop',
        isAbort: false,
        isDisconnect: false,
        isError: false,
      })
    })
    expect(screen.getByRole('status')).toHaveTextContent('The completed answer.')
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
  })

  it('shows a toast when the chat hook reports an error', () => {
    useChatMock.mockReturnValue({
      status: 'ready',
      error: new Error('AMA_ERROR:timeout'),
      clearError: clearErrorMock,
      regenerate: regenerateMock,
      sendMessage: sendMessageMock,
      setMessages: setMessagesMock,
      stop: stopMock,
      messages: [],
    })

    render(<AMAPage />)

    expect(toastMock).toHaveBeenCalledWith({
      title: 'Response timed out',
      description: 'The model took too long to respond. Please retry.',
      variant: 'destructive',
    })
  })

  it('does not render the processing placeholder for assistant messages without text parts', () => {
    useChatMock.mockReturnValue({
      status: 'streaming',
      error: undefined,
      clearError: clearErrorMock,
      regenerate: regenerateMock,
      sendMessage: sendMessageMock,
      setMessages: setMessagesMock,
      stop: stopMock,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-get_resume',
              state: 'output-available',
              input: {},
              output: { available: true },
            },
          ],
        },
      ],
    })

    render(<AMAPage />)

    expect(screen.queryByText('segov@terminal:~$ processing...')).not.toBeInTheDocument()
  })

  it('submits prompt suggestions through useChat sendMessage', () => {
    useChatMock.mockReturnValue({
      status: 'ready',
      error: undefined,
      clearError: clearErrorMock,
      regenerate: regenerateMock,
      sendMessage: sendMessageMock,
      setMessages: setMessagesMock,
      stop: stopMock,
      messages: [
        {
          id: 'initial',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'segov@terminal:~$ ./ama \nAsk me anything about my work and projects.',
            },
          ],
        },
      ],
    })

    render(<AMAPage />)

    fireEvent.click(screen.getByText('Tell me about your career'))

    expect(sendMessageMock).toHaveBeenCalledWith({ text: 'Tell me about your career' })
  })

  it('handles help locally without sending a chat request', () => {
    render(<AMAPage />)

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'help' } })
    fireEvent.submit(input.closest('form')!)

    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(setMessagesMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          parts: [expect.objectContaining({ text: expect.stringContaining('Commands:') })],
        }),
      ]),
    )
  })

  it('clears local session state with clear command', () => {
    window.localStorage.setItem(storageKey, JSON.stringify([{ id: 'saved' }]))
    render(<AMAPage />)

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'clear' } })
    fireEvent.submit(input.closest('form')!)

    expect(window.localStorage.getItem(storageKey)).toBeNull()
    expect(setMessagesMock).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'initial',
        role: 'assistant',
      }),
    ])
  })

  it('stops an active response from the visible control', () => {
    useChatMock.mockReturnValue({
      status: 'streaming',
      error: undefined,
      clearError: clearErrorMock,
      regenerate: regenerateMock,
      sendMessage: sendMessageMock,
      setMessages: setMessagesMock,
      stop: stopMock,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Tell me about work' }],
        },
      ],
    })

    render(<AMAPage />)
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))

    expect(stopMock).toHaveBeenCalled()
  })

  it('disables text input while a response is active', () => {
    useChatMock.mockReturnValue({
      status: 'streaming',
      error: undefined,
      clearError: clearErrorMock,
      regenerate: regenerateMock,
      sendMessage: sendMessageMock,
      setMessages: setMessagesMock,
      stop: stopMock,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Tell me about work' }],
        },
      ],
    })

    render(<AMAPage />)

    expect(screen.getByRole('textbox')).toBeDisabled()
  })

  it('regenerates the previous response from retry command', () => {
    useChatMock.mockReturnValue({
      status: 'ready',
      error: undefined,
      clearError: clearErrorMock,
      regenerate: regenerateMock,
      sendMessage: sendMessageMock,
      setMessages: setMessagesMock,
      stop: stopMock,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Tell me about work' }],
        },
      ],
    })

    render(<AMAPage />)

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'retry' } })
    fireEvent.submit(input.closest('form')!)

    expect(regenerateMock).toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it('clears stale errors before retrying from the visible control', () => {
    useChatMock.mockReturnValue({
      status: 'ready',
      error: new Error('chat unavailable'),
      clearError: clearErrorMock,
      regenerate: regenerateMock,
      sendMessage: sendMessageMock,
      setMessages: setMessagesMock,
      stop: stopMock,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Tell me about work' }],
        },
      ],
    })

    render(<AMAPage />)

    fireEvent.click(screen.getByRole('button', { name: /retry/i }))

    expect(clearErrorMock).toHaveBeenCalled()
    expect(regenerateMock).toHaveBeenCalled()
  })

  it('loads stored text messages on mount', async () => {
    const storedMessages = [
      {
        id: 'stored-user',
        role: 'user',
        parts: [{ type: 'text', text: 'Stored prompt' }],
      },
    ]
    window.localStorage.setItem(storageKey, JSON.stringify(storedMessages))

    render(<AMAPage />)

    await waitFor(() => {
      expect(setMessagesMock).toHaveBeenCalledWith(storedMessages)
    })
  })

  it('migrates the legacy saved greeting during localStorage hydration', async () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify([
        {
          id: 'initial',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'segov@terminal:~$ ./ama \nAsk me anything about Jonathan.',
            },
          ],
        },
      ]),
    )

    render(<AMAPage />)

    await waitFor(() => {
      expect(setMessagesMock).toHaveBeenCalledWith([
        {
          id: 'initial',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'segov@terminal:~$ ./ama \nAsk me anything about my work and projects.',
            },
          ],
        },
      ])
    })
  })

  it('ignores corrupt stored messages', async () => {
    window.localStorage.setItem(storageKey, '{bad json')

    render(<AMAPage />)

    await waitFor(() => {
      expect(setMessagesMock).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'initial',
          role: 'assistant',
        }),
      ])
    })
  })

  it('keeps chat and clear working when access to localStorage is blocked, with one notice', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('Storage is blocked', 'SecurityError')
      },
    })
    render(<AMAPage />)

    const input = screen.getByRole('textbox', { name: 'Ask a question' })
    fireEvent.change(input, { target: { value: 'Tell me about your work' } })
    fireEvent.submit(input.closest('form')!)
    expect(sendMessageMock).toHaveBeenCalledWith({ text: 'Tell me about your work' })
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(setMessagesMock).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'initial', role: 'assistant' }),
    ])
    expect(
      toastMock.mock.calls.filter(([notice]) => notice.title === 'Local history unavailable'),
    ).toHaveLength(1)
  })

  it('continues in memory after quota or removal failures and reports persistence once', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota full', 'QuotaExceededError')
    })
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage is blocked', 'SecurityError')
    })
    render(<AMAPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    expect(setMessagesMock).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'initial', role: 'assistant' }),
    ])
    expect(
      toastMock.mock.calls.filter(([notice]) => notice.title === 'Local history unavailable'),
    ).toHaveLength(1)
  })

  it('does not persist tool parts to local storage or strip live message state', async () => {
    useChatMock.mockReturnValue({
      status: 'ready',
      error: undefined,
      clearError: clearErrorMock,
      regenerate: regenerateMock,
      sendMessage: sendMessageMock,
      setMessages: setMessagesMock,
      stop: stopMock,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Public text only.' },
            {
              type: 'tool-get_resume',
              state: 'output-available',
              input: {},
              output: { content: 'private context' },
            },
          ],
        },
      ],
    })

    render(<AMAPage />)

    await waitFor(() => {
      const persistedMessages = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]')
      expect(persistedMessages).toEqual([
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Public text only.' }],
        },
      ])
      expect(setMessagesMock).not.toHaveBeenCalledWith([
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Public text only.' }],
        },
      ])
    })
  })

  it('renders deterministic follow-up suggestions and sends them when clicked', () => {
    useChatMock.mockReturnValue({
      status: 'ready',
      error: undefined,
      clearError: clearErrorMock,
      regenerate: regenerateMock,
      sendMessage: sendMessageMock,
      setMessages: setMessagesMock,
      stop: stopMock,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Tell me about projects' }],
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Jonathan has worked on AI projects and segov.dev.' }],
        },
      ],
    })

    render(<AMAPage />)

    fireEvent.click(screen.getByText('Which of your projects use AI?'))

    expect(sendMessageMock).toHaveBeenCalledWith({ text: 'Which of your projects use AI?' })
  })

  it('does not classify common ai substrings as project follow-ups', () => {
    useChatMock.mockReturnValue({
      status: 'ready',
      error: undefined,
      clearError: clearErrorMock,
      regenerate: regenerateMock,
      sendMessage: sendMessageMock,
      setMessages: setMessagesMock,
      stop: stopMock,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: "Tell me about Jonathan's career" }],
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'Available details explain how he maintains reliable systems.',
            },
          ],
        },
      ],
    })

    render(<AMAPage />)

    expect(screen.getByText('What backend or platform work have you done?')).toBeInTheDocument()
    expect(screen.queryByText('Which of your projects use AI?')).not.toBeInTheDocument()
  })

  it('does not classify work substrings as career follow-ups', () => {
    useChatMock.mockReturnValue({
      status: 'ready',
      error: undefined,
      clearError: clearErrorMock,
      regenerate: regenerateMock,
      sendMessage: sendMessageMock,
      setMessages: setMessagesMock,
      stop: stopMock,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Tell me more' }],
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'The framework uses reliable network patterns.',
            },
          ],
        },
      ],
    })

    render(<AMAPage />)

    expect(screen.getByText('Tell me about your career')).toBeInTheDocument()
    expect(
      screen.queryByText('What backend or platform work have you done?'),
    ).not.toBeInTheDocument()
  })
})
