import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AMAPage from '@/app/ama/page'

const {
  clearErrorMock,
  regenerateMock,
  sendMessageMock,
  setMessagesMock,
  stopMock,
  toastMock,
  useChatMock,
} = vi.hoisted(() => ({
  clearErrorMock: vi.fn(),
  regenerateMock: vi.fn(),
  sendMessageMock: vi.fn(),
  setMessagesMock: vi.fn(),
  stopMock: vi.fn(),
  toastMock: vi.fn(),
  useChatMock: vi.fn(),
}))

vi.mock('@ai-sdk/react', () => ({
  useChat: useChatMock,
}))

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

  beforeEach(() => {
    vi.clearAllMocks()
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
              text: 'Error: Query outside permitted scope. This terminal only responds to questions about Jonathan Segovia.',
            },
          ],
        },
      ],
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders streamed assistant output in terminal view', () => {
    render(<AMAPage />)
    expect(
      screen.getByText(
        'Error: Query outside permitted scope. This terminal only responds to questions about Jonathan Segovia.',
      ),
    ).toBeInTheDocument()
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

  it('shows a toast when the chat hook reports an error', () => {
    useChatMock.mockReturnValue({
      status: 'ready',
      error: new Error('chat unavailable'),
      clearError: clearErrorMock,
      regenerate: regenerateMock,
      sendMessage: sendMessageMock,
      setMessages: setMessagesMock,
      stop: stopMock,
      messages: [],
    })

    render(<AMAPage />)

    expect(toastMock).toHaveBeenCalledWith({
      title: 'API Error',
      description: 'Failed to get a response from the API. Please try again later.',
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
              text: 'segov@terminal:~$ ./ama \nAsk me anything about Jonathan.',
            },
          ],
        },
      ],
    })

    render(<AMAPage />)

    fireEvent.click(screen.getByText("Tell me about Jonathan's career"))

    expect(sendMessageMock).toHaveBeenCalledWith({ text: "Tell me about Jonathan's career" })
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

    fireEvent.click(screen.getByText('Which projects use AI?'))

    expect(sendMessageMock).toHaveBeenCalledWith({ text: 'Which projects use AI?' })
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

    expect(screen.getByText('What backend or platform work has Jonathan done?')).toBeInTheDocument()
    expect(screen.queryByText('Which projects use AI?')).not.toBeInTheDocument()
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

    expect(screen.getByText("Tell me about Jonathan's career")).toBeInTheDocument()
    expect(
      screen.queryByText('What backend or platform work has Jonathan done?'),
    ).not.toBeInTheDocument()
  })
})
