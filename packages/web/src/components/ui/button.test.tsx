import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Button } from './button'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

describe('Button', () => {
  it('lets a caller className override a variant class', () => {
    render(<Button className="bg-muted">Label</Button>)
    const button = screen.getByRole('button')

    const classes = button.className.split(' ')
    expect(classes).toContain('bg-muted')
    expect(classes).not.toContain('bg-action')
  })

  it('renders the child element instead of a button when asChild is set', () => {
    render(
      <Button asChild variant="contrast">
        <a href="/tasks">Tasks</a>
      </Button>
    )

    const link = screen.getByRole('link', { name: 'Tasks' })
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/tasks')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('is inert while disabled', () => {
    render(<Button disabled>Label</Button>)
    const button = screen.getByRole('button')

    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('dims a disabled primary button to the gold tint at full opacity', () => {
    render(<Button disabled>Label</Button>)
    const classes = screen.getByRole('button').className.split(' ')

    for (const name of ['disabled:bg-action/20', 'disabled:text-foreground/80', 'disabled:border-action/35', 'disabled:opacity-100']) expect(classes).toContain(name)
    expect(classes).not.toContain('disabled:opacity-50')
  })
})
