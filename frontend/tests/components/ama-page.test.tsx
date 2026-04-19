import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AMAPage from '@/app/ama/page'

const { sendMessageMock, toastMock, useChatMock, fetchMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  toastMock: vi.fn(),
  useChatMock: vi.fn(),
  fetchMock: vi.fn(),
}))

const webSocketInstances: MockWebSocket[] = []
const localStorageState = new Map<string, string>()

const localStorageMock = {
  getItem: vi.fn((key: string) => localStorageState.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    localStorageState.set(key, value)
  }),
  removeItem: vi.fn((key: string) => {
    localStorageState.delete(key)
  }),
  clear: vi.fn(() => {
    localStorageState.clear()
  }),
}

class MockAudioBuffer {
  readonly duration: number
  private readonly channelData: Float32Array

  constructor(length: number, sampleRate: number) {
    this.duration = length / sampleRate
    this.channelData = new Float32Array(length)
  }

  getChannelData() {
    return this.channelData
  }
}

class MockAudioBufferSourceNode {
  buffer: MockAudioBuffer | null = null
  onended: (() => void) | null = null
  readonly connect = vi.fn()
  readonly disconnect = vi.fn()
  readonly start = vi.fn()
  readonly stop = vi.fn()

  finish() {
    this.onended?.()
  }
}

class MockAudioContext {
  currentTime = 0
  destination = {} as AudioNode
  state: AudioContextState = 'suspended'
  readonly sources: MockAudioBufferSourceNode[] = []
  readonly createBuffer = vi.fn(
    (_channels: number, length: number, sampleRate: number) =>
      new MockAudioBuffer(length, sampleRate) as unknown as AudioBuffer,
  )
  readonly createBufferSource = vi.fn(() => {
    const source = new MockAudioBufferSourceNode()
    this.sources.push(source)
    return source as unknown as AudioBufferSourceNode
  })
  readonly resume = vi.fn(async () => {
    this.state = 'running'
  })
  readonly close = vi.fn(async () => {
    this.state = 'closed'
  })
}

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readonly send = vi.fn()
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.readyState = MockWebSocket.CLOSED
    this.closeArgs = { code, reason }
  })
  readonly url: string
  readonly protocols: string[]
  binaryType: BinaryType = 'blob'
  readyState = MockWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  closeArgs: { code?: number; reason?: string } | null = null

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url)
    this.protocols = Array.isArray(protocols) ? protocols : protocols ? [protocols] : []
    webSocketInstances.push(this)
  }

  dispatchOpen() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  dispatchMessage(data: ArrayBuffer | Blob | string) {
    this.onmessage?.({ data } as MessageEvent)
  }

  dispatchClose() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code: 1000, reason: 'closed', wasClean: true } as CloseEvent)
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

function createVoiceTokenResponse() {
  return new Response(
    JSON.stringify({
      accessToken: 'voice-token',
      expiresIn: 60,
      model: 'aura-2-thalia-en',
      encoding: 'linear16',
      sampleRate: 24000,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    },
  )
}

describe('AMA page', () => {
  beforeEach(() => {
    sendMessageMock.mockReset()
    toastMock.mockReset()
    useChatMock.mockReset()
    fetchMock.mockReset()
    webSocketInstances.length = 0
    localStorageMock.clear()
    localStorageMock.getItem.mockClear()
    localStorageMock.setItem.mockClear()
    localStorageMock.removeItem.mockClear()
    localStorageMock.clear.mockClear()

    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
    vi.stubGlobal('AudioContext', MockAudioContext as unknown as typeof AudioContext)
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: MockWebSocket,
    })
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: localStorageMock,
    })
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: MockAudioContext,
    })
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: localStorageMock,
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
    useChatMock.mockImplementation(() => chatState)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders assistant output without per-message playback controls', () => {
    render(<AMAPage />)

    expect(
      screen.getByText(
        'Error: Query outside permitted scope. This terminal only responds to questions about Jonathan Segovia.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /play audio/i })).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /toggle voice mode/i })).toBeInTheDocument()
  })

  it('submits user prompts through useChat sendMessage', async () => {
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

  it('persists voice mode and avoids opening the websocket before a user gesture', async () => {
    localStorageMock.setItem('ama-voice-mode-enabled', 'true')
    fetchMock.mockResolvedValue(createVoiceTokenResponse())

    render(<AMAPage />)

    expect(screen.getByRole('switch', { name: /toggle voice mode/i })).toHaveAttribute(
      'data-state',
      'checked',
    )
    expect(fetchMock).not.toHaveBeenCalled()

    const input = screen.getByRole('textbox', { name: 'Ask a question' })
    fireEvent.change(input, { target: { value: 'Tell me about your work.' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/tts/token', {
        method: 'POST',
        signal: expect.any(AbortSignal),
      })
    })
    expect(webSocketInstances).toHaveLength(1)
  })

  it('opens a Deepgram websocket when voice mode is enabled', async () => {
    fetchMock.mockResolvedValueOnce(createVoiceTokenResponse())

    render(<AMAPage />)

    fireEvent.click(screen.getByRole('switch', { name: /toggle voice mode/i }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    expect(webSocketInstances).toHaveLength(1)
    expect(webSocketInstances[0]?.url).toContain('wss://api.deepgram.com/v1/speak')
    expect(webSocketInstances[0]?.protocols).toEqual(['token', 'voice-token'])
  })

  it('does not retry a superseded socket connection after a new submit starts a replacement one', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(createVoiceTokenResponse()))

    render(<AMAPage />)

    fireEvent.click(screen.getByRole('switch', { name: /toggle voice mode/i }))
    await waitFor(() => {
      expect(webSocketInstances).toHaveLength(1)
    })

    const input = screen.getByRole('textbox', { name: 'Ask a question' })
    fireEvent.change(input, { target: { value: 'Tell me about your work.' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith({ text: 'Tell me about your work.' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(webSocketInstances).toHaveLength(2)
    })

    webSocketInstances[0]?.dispatchClose()

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(webSocketInstances).toHaveLength(2)
    expect(webSocketInstances[1]?.close).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Voice Error' }))
  })

  it('streams assistant text to the Deepgram websocket and flushes at turn completion', async () => {
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
      ],
    }
    useChatMock.mockImplementation(() => chatState)
    fetchMock.mockResolvedValueOnce(createVoiceTokenResponse())

    const { rerender } = render(<AMAPage />)

    fireEvent.click(screen.getByRole('switch', { name: /toggle voice mode/i }))
    await waitFor(() => {
      expect(webSocketInstances).toHaveLength(1)
    })
    webSocketInstances[0]?.dispatchOpen()

    chatState.status = 'streaming'
    chatState.messages = [
      ...chatState.messages,
      {
        id: 'assistant-2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello there. How' }],
      },
    ]
    rerender(<AMAPage />)

    await waitFor(() => {
      expect(webSocketInstances[0]?.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'Speak', text: 'Hello there.' }),
      )
    })

    chatState.messages = [
      chatState.messages[0]!,
      {
        id: 'assistant-2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello there. How are you today?' }],
      },
    ]
    rerender(<AMAPage />)

    await waitFor(() => {
      expect(webSocketInstances[0]?.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'Speak', text: 'How are you today?' }),
      )
    })

    chatState.status = 'ready'
    rerender(<AMAPage />)

    await waitFor(() => {
      expect(webSocketInstances[0]?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'Flush' }))
    })
  })

  it('shows a global stop control and clears live voice when stopped', async () => {
    const chatState = {
      status: 'streaming',
      error: undefined,
      sendMessage: sendMessageMock,
      messages: [
        {
          id: 'assistant-2',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Hello there.' }],
        },
      ],
    }
    useChatMock.mockImplementation(() => chatState)
    fetchMock.mockResolvedValueOnce(createVoiceTokenResponse())

    render(<AMAPage />)

    fireEvent.click(screen.getByRole('switch', { name: /toggle voice mode/i }))
    await waitFor(() => {
      expect(webSocketInstances).toHaveLength(1)
    })
    webSocketInstances[0]?.dispatchOpen()

    await screen.findByRole('button', { name: /stop voice/i })
    fireEvent.click(screen.getByRole('button', { name: /stop voice/i }))

    expect(webSocketInstances[0]?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'Clear' }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /stop voice/i })).not.toBeInTheDocument()
    })
  })

  it('does not stream the seeded intro or tool-only assistant updates', async () => {
    const chatState = {
      status: 'streaming',
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
          id: 'assistant-tool',
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
    }
    useChatMock.mockImplementation(() => chatState)
    fetchMock.mockResolvedValueOnce(createVoiceTokenResponse())

    render(<AMAPage />)

    fireEvent.click(screen.getByRole('switch', { name: /toggle voice mode/i }))
    await waitFor(() => {
      expect(webSocketInstances).toHaveLength(1)
    })
    webSocketInstances[0]?.dispatchOpen()

    await waitFor(() => {
      expect(webSocketInstances[0]?.send).not.toHaveBeenCalledWith(
        expect.stringContaining('"type":"Speak"'),
      )
    })
  })

  it('sends Clear and Close when voice mode is toggled off', async () => {
    fetchMock.mockResolvedValueOnce(createVoiceTokenResponse())

    render(<AMAPage />)

    const voiceModeSwitch = screen.getByRole('switch', { name: /toggle voice mode/i })
    fireEvent.click(voiceModeSwitch)

    await waitFor(() => {
      expect(webSocketInstances).toHaveLength(1)
    })
    webSocketInstances[0]?.dispatchOpen()

    fireEvent.click(voiceModeSwitch)

    expect(webSocketInstances[0]?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'Clear' }))
    expect(webSocketInstances[0]?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'Close' }))
    expect(webSocketInstances[0]?.close).toHaveBeenCalledWith(1000, 'Voice mode ended')
  })

  it('cleans up the websocket connection on unmount', async () => {
    fetchMock.mockResolvedValueOnce(createVoiceTokenResponse())

    const { unmount } = render(<AMAPage />)

    fireEvent.click(screen.getByRole('switch', { name: /toggle voice mode/i }))
    await waitFor(() => {
      expect(webSocketInstances).toHaveLength(1)
    })
    webSocketInstances[0]?.dispatchOpen()

    unmount()

    expect(webSocketInstances[0]?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'Close' }))
    expect(webSocketInstances[0]?.close).toHaveBeenCalledWith(1000, 'Voice mode ended')
  })
})
