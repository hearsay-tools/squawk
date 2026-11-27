import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NewTaskQuickPrompts } from './new-task-sections'

afterEach(cleanup)

describe('NewTaskQuickPrompts', () => {
  it('renders starter prompts when no saved templates exist and inserts text on click', () => {
    const onInsert = vi.fn()
    render(<NewTaskQuickPrompts templates={[]} onInsert={onInsert} />)

    expect(screen.getByRole('heading', { level: 2, name: 'Quick start prompts' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Fix a bug' }))
    expect(onInsert).toHaveBeenCalledWith(expect.stringContaining('regression test'))
  })

  it('renders saved prompt templates when provided and inserts their text', () => {
    const onInsert = vi.fn()
    render(
      <NewTaskQuickPrompts
        templates={[
          { id: 't1', label: 'Release notes', text: 'Draft release notes from recent commits.' },
          { id: 't2', label: 'Refactor', text: 'Simplify the module without changing behavior.' },
        ]}
        onInsert={onInsert}
      />,
    )

    expect(screen.getByRole('heading', { level: 2, name: 'Saved templates' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Release notes' }))
    expect(onInsert).toHaveBeenCalledWith('Draft release notes from recent commits.')
  })
})
