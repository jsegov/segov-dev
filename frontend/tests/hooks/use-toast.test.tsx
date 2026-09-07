import React, { useEffect } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { toast, useToast } from '@/hooks/use-toast'

afterEach(cleanup)

function EmitOnMount() {
  useEffect(() => {
    toast({ title: 'Local history unavailable' })
  }, [])
  return null
}

function Notices() {
  const { toasts } = useToast()
  return toasts.map((notice) => <p key={notice.id}>{notice.title}</p>)
}

describe('toast store subscription', () => {
  it('receives a sibling mount effect toast dispatched before the subscriber effect', () => {
    render(
      <>
        <EmitOnMount />
        <Notices />
      </>,
    )
    expect(screen.getByText('Local history unavailable')).toBeInTheDocument()
  })
})
