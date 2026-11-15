import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { toolDisplay } from '@open-mercato/cezar-api-client/contract/tool-display'
import type { UiToolItem } from '@open-mercato/cezar-api-client'

import { ToolCard } from './thread-items'

afterEach(cleanup)

const MARKER = 'unique-marker-past-the-title-limit'
const long = (head: string) => `${head}${'segment/'.repeat(16)}${MARKER}`

function card(name: string, input: unknown): UiToolItem {
  const display = toolDisplay(name, input)
  return { kind: 'tool', id: `tool-${name}`, name, toolKind: display.toolKind, title: display.title, status: 'completed', input }
}

const body = () => document.querySelector('[data-slot="tool-command"]')?.textContent

describe('ToolCard expanded detail from raw input (hearsay-tools/squawk#3524)', () => {
  it.each([
    ['Read', { file_path: long('/home/agent/projects/') }, /Read/, long('/home/agent/projects/')],
    ['Grep', { pattern: long('function\\s+'), path: 'src' }, /Search/, long('function\\s+')],
    ['WebFetch', { url: long('https://example.com/') }, /Fetch/, long('https://example.com/')],
  ] as const)('shows the whole %s input when expanded and keeps the header short', (name, input, verb, full) => {
    render(<ToolCard item={card(name, input)} />)
    const button = screen.getByRole('button', { name: verb })
    expect(button.textContent).not.toContain(MARKER)
    fireEvent.click(button)
    expect(body()).toBe(full)
  })

  it('shows the full Task prompt when expanded and keeps the description in the header', () => {
    const prompt = long('Audit the auth flow.\nRead every middleware file under ')
    render(<ToolCard item={card('Task', { description: 'Audit the auth flow', prompt, subagent_type: 'general-purpose' })} />)
    const button = screen.getByRole('button', { name: /Task/ })
    expect(button.textContent).toContain('Audit the auth flow')
    expect(button.textContent).not.toContain(MARKER)
    fireEvent.click(button)
    expect(body()).toBe(prompt)
  })

  it('shows the title detail when the item has no raw input', () => {
    const item: UiToolItem = { kind: 'tool', id: 'tool-read', name: 'Read', toolKind: 'read', title: 'Read src/a.ts', status: 'completed' }
    render(<ToolCard item={item} />)
    fireEvent.click(screen.getByRole('button', { name: /Read/ }))
    expect(body()).toBe('src/a.ts')
  })
})
