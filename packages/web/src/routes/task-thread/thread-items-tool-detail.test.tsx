import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { toolDisplay } from '@open-mercato/cezar-api-client/contract/tool-display'
import type { UiToolItem } from '@open-mercato/cezar-api-client'

import claudeBackgroundAgent from '../../../../cezar/src/core/__fixtures__/claude/background-agent.expected.json'
import claudeTask from '../../../../cezar/src/core/__fixtures__/claude/subagent-task.expected.json'
import codexCollab from '../../../../cezar/src/core/__fixtures__/codex/collab-agent-tool-call.expected.json'
import cursorTools from '../../../../cezar/src/core/__fixtures__/cursor/print-tools.expected.json'
import ompSubagents from '../../../../cezar/src/core/__fixtures__/omp/rpc-subagents.expected.json'
import opencodeSubtask from '../../../../cezar/src/core/__fixtures__/opencode/subtask-nested.expected.json'
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

/** The last snapshot of a mapper's golden item: the shape each runner really emits. */
function goldenItem(events: object[], id: string): UiToolItem {
  const items = (events as Array<{ item?: UiToolItem }>).flatMap((event) => event.item?.kind === 'tool' && event.item.id === id ? [event.item] : [])
  if (items.length === 0) throw new Error(`no golden tool item ${id}`)
  return items.at(-1)!
}

describe('ToolCard expanded detail for every runner subagent shape (hearsay-tools/squawk#3524)', () => {
  it.each([
    ['claude Agent', claudeBackgroundAgent, 'toolu_bg_fixture_01', 'prompt'],
    ['claude Task', claudeTask, 'toolu_task_01', 'prompt'],
    ['codex spawnAgent', codexCollab, 'item_spawn', 'prompt'],
    ['cursor Task', cursorTools, 'task_1', 'prompt'],
    ['omp task', ompSubagents, 'toolu_task_1', 'task'],
    ['opencode subtask', opencodeSubtask, 'prt_01J8ZE51SUBT', 'prompt'],
  ] as const)('shows the whole %s prompt when expanded', (_runner, events, id, key) => {
    const golden = goldenItem(events as object[], id)
    const text = long('Read every middleware file under ')
    const item: UiToolItem = { ...golden, input: { ...(golden.input as object), [key]: text }, output: undefined }
    render(<ToolCard item={item} />)
    const button = document.querySelector<HTMLButtonElement>('[data-slot="tool-card"] button, button')!
    expect(button.textContent).not.toContain(MARKER)
    fireEvent.click(button)
    expect(body()).toBe(text)
  })
})

