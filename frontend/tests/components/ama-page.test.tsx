import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AMAPage from '@/app/ama/page'

const {
  sendMessageMock,
  toastMock,
  useChatMock,
  fetchMock,
  createObjectURLMock,
  revokeObjectURLMock,
} = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  toastMock: vi.fn(),
  useChatMock: vi.fn(),
  fetchMock: vi.fn(),
  createObjectURLMock: vi.fn(),
  revokeObjectURLMock: vi.fn(),
}))

const audioInstances: MockAudio[] = []

class MockAudio {
  currentTime = 0
  muted = false
  onended: ((this: HTMLAudioElement, ev: Event) => unknown) | null = null
  load = vi.fn()
  pause = vi.fn()
  play = vi.fn(async () => undefined)
  removeAttribute = vi.fn()
  src: string

  constructor(src = '') {
    this.src = src
    audioInstances.push(this)
  }
}

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
  beforeEach(() => {
    sendMessageMock.mockReset()
    toastMock.mockReset()
    useChatMock.mockReset()
    fetchMock.mockReset()
    createObjectURLMock.mockReset()
    revokeObjectURLMock.mockReset()
    audioInstances.length = 0
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('Audio', MockAudio as unknown as typeof Audio)
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURLMock.mockReturnValue('blob:tts-audio'),
    })
    Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURLMock,
    })
    const chatState = {
      status: 'ready',
      error: undefined,
      sendMessage: sendMessageMock,
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
    }
    useChatMock.mockReturnValue(chatState)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
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

  it('renders a play control for assistant replies but not for the seeded intro or user messages', () => {
    const chatState = {
      status: 'ready',
      error: undefined,
      sendMessage: sendMessageMock,
      messages: [
        {
          id: 'initial',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'segov@terminal:~$ ./ama \nAsk me anything about Jonathan.' },
          ],
        },
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Tell me about your work.' }],
        },
        {
          id: 'assistant-2',
          role: 'assistant',
          parts: [{ type: 'text', text: 'I build frontend systems.' }],
        },
      ],
    }
    useChatMock.mockReturnValue(chatState)

    render(<AMAPage />)

    expect(
      screen.getAllByRole('button', { name: /play audio for assistant response/i }),
    ).toHaveLength(1)
    expect(
      screen.queryByRole('button', { name: /play audio for assistant response 2/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /play audio for assistant response 1/i }),
    ).toBeInTheDocument()
  })

  it('submits user prompt through useChat sendMessage', async () => {
    render(<AMAPage />)

    const input = screen.getByRole('textbox', { name: 'Ask a question' })
    fireEvent.change(input, { target: { value: 'Tell me about your work.' } })
    fireEvent.submit(input.closest('form')!)

    expect(sendMessageMock).toHaveBeenCalledWith({ text: 'Tell me about your work.' })
  })

  it('shows a toast when the chat hook reports an error', () => {
    useChatMock.mockReturnValueOnce({
      status: 'ready',
      error: new Error('chat unavailable'),
      sendMessage: sendMessageMock,
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
    useChatMock.mockReturnValueOnce({
      status: 'streaming',
      error: undefined,
      sendMessage: sendMessageMock,
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
    expect(screen.queryByRole('button', { name: /assistant response 1/i })).not.toBeInTheDocument()
  })

  it('does not render a play control for the currently streaming assistant reply', () => {
    useChatMock.mockReturnValueOnce({
      status: 'streaming',
      error: undefined,
      sendMessage: sendMessageMock,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Finished response.' }],
        },
        {
          id: 'assistant-2',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Streaming response in progress' }],
        },
      ],
    })

    render(<AMAPage />)

    expect(
      screen.getByRole('button', { name: /play audio for assistant response 1/i }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /assistant response 2/i })).not.toBeInTheDocument()
  })

  it('requests text to speech, shows a loading state, and toggles to stop while playing', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve
      }),
    )

    render(<AMAPage />)

    fireEvent.click(screen.getByRole('button', { name: /play audio for assistant response 1/i }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: 'Error: Query outside permitted scope. This terminal only responds to questions about Jonathan Segovia.',
        }),
      })
    })
    const loadingButton = screen.getByRole('button', {
      name: /loading audio for assistant response 1/i,
    })
    expect(loadingButton).toHaveTextContent('Loading...')
    expect(loadingButton).toBeDisabled()

    resolveFetch?.(
      new Response('audio-bytes', { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }),
    )

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /stop audio for assistant response 1/i }),
      ).toBeInTheDocument()
    })

    expect(createObjectURLMock).toHaveBeenCalledTimes(1)
    expect(audioInstances).toHaveLength(1)
    expect(audioInstances[0]?.play).toHaveBeenCalledTimes(2)
  })

  it('stops playback and clears state when stop is clicked', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('audio-bytes', { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }),
    )

    render(<AMAPage />)

    fireEvent.click(screen.getByRole('button', { name: /play audio for assistant response 1/i }))

    const stopButton = await screen.findByRole('button', {
      name: /stop audio for assistant response 1/i,
    })
    fireEvent.click(stopButton)

    expect(audioInstances[0]?.pause).toHaveBeenCalledTimes(2)
    expect(audioInstances[0]?.currentTime).toBe(0)
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:tts-audio')
    expect(
      screen.getByRole('button', { name: /play audio for assistant response 1/i }),
    ).toBeInTheDocument()
  })

  it('stops the current reply before starting another one', async () => {
    createObjectURLMock.mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second')
    fetchMock
      .mockResolvedValueOnce(
        new Response('first-audio', { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }),
      )
      .mockResolvedValueOnce(
        new Response('second-audio', { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }),
      )

    const chatState = {
      status: 'ready',
      error: undefined,
      sendMessage: sendMessageMock,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'First reply.' }],
        },
        {
          id: 'assistant-2',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Second reply.' }],
        },
      ],
    }
    useChatMock.mockImplementation(() => chatState)

    render(<AMAPage />)

    expect(screen.getByText('First reply.')).toBeInTheDocument()
    expect(screen.getByText('Second reply.')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /play audio for assistant response 2/i }),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /play audio for assistant response 1/i }))
    await screen.findByRole('button', { name: /stop audio for assistant response 1/i })

    fireEvent.click(screen.getByRole('button', { name: /play audio for assistant response 2/i }))

    await screen.findByRole('button', { name: /stop audio for assistant response 2/i })

    expect(audioInstances[0]?.pause).toHaveBeenCalledTimes(2)
    expect(audioInstances[0]?.currentTime).toBe(0)
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:first')
    expect(audioInstances[1]?.play).toHaveBeenCalledTimes(2)
  })

  it('shows a toast when text to speech fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))

    render(<AMAPage />)

    fireEvent.click(screen.getByRole('button', { name: /play audio for assistant response 1/i }))

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Audio Error',
        description: 'Failed to play audio for this response. Please try again later.',
        variant: 'destructive',
      })
    })
  })

  it('exposes transcript, input, and playback accessibility attributes', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('audio-bytes', { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }),
    )

    render(<AMAPage />)

    const transcript = screen.getByRole('log')
    expect(transcript).toHaveAttribute('aria-live', 'polite')
    expect(transcript).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByRole('textbox', { name: 'Ask a question' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /play audio for assistant response 1/i }))

    const stopButton = await screen.findByRole('button', {
      name: /stop audio for assistant response 1/i,
    })
    expect(stopButton).toHaveAttribute('aria-pressed', 'true')
  })
})
