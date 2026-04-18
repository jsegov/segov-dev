import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import AMAPage from '@/app/ama/page'

const { sendMessageMock, toastMock, useChatMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
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
  beforeEach(() => {
    vi.clearAllMocks()
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
  })
})
