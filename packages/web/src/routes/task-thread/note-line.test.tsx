import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { NoteLine } from './note-line'

afterEach(cleanup)

it('renders a neutral lifecycle note without a leading separator', () => {
  render(<NoteLine note={{ kind: 'note', id: 'review', tone: 'dim', text: 'Changes ready for review' }} />)
  expect(screen.getByText('Changes ready for review').textContent).toBe('Changes ready for review')
})
