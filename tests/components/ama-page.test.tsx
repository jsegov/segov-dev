import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AMAPage from '@/app/ama/page'

const { fetchMock, sendMessageMock, useChatMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  sendMessageMock: vi.fn(),
  useChatMock: vi.fn(),
}))

vi.mock('@ai-sdk/react', () => ({
  useChat: useChatMock,
}))

vi.mock('@/components/navbar', () => ({
  Navbar: () => <div data-testid="navbar" />,
}))

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({
    toast: vi.fn(),
  }),
}))

describe('AMA page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 204,
      }),
    )
    useChatMock.mockReturnValue({
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
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders streamed assistant output in terminal view', () => {
    render(<AMAPage />)
    expect(
      screen.getByText(
        'Error: Query outside permitted scope. This terminal only responds to questions about Jonathan Segovia.',
      ),
    ).toBeInTheDocument()
  })

  it('submits user prompt through useChat sendMessage', async () => {
    render(<AMAPage />)

    const input = screen.getByRole('textbox')
    await waitFor(() => expect(input).not.toBeDisabled())
    fireEvent.change(input, { target: { value: 'Tell me about your work.' } })
    fireEvent.submit(input.closest('form')!)

    expect(sendMessageMock).toHaveBeenCalledWith({ text: 'Tell me about your work.' })
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
  })

  it('shows the bootstrap message until the ama session is ready', () => {
    fetchMock.mockImplementationOnce(() => new Promise(() => {}))

    render(<AMAPage />)

    expect(screen.getByText('Preparing AMA session...')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeDisabled()
  })
})
