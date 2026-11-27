import { TOOL_STATUSES } from '@open-mercato/cezar-api-client/protocol/ui-events'
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiRun, RunEvent } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { seedRunners } from '@/test/runners.testkit'

import {
  DesktopActivityHeaderControl,
  MobileActivityHeaderControl,
  ULTRAWIDE_ACTIVITY_QUERY,
} from './run-activity-header'
import { reduceThread } from './thread-state'

vi.mock('@/api/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/queries')>()
  return {
    ...actual,
    useHealth: () => ({ data: { capabilities: {} } }),
    useRuns: () => ({ data: [] }),
    useRunRelationships: () => ({ data: { workers: [], titles: {} } }),
  }
})

const FIXED_TIME = '2026-01-15T12:00:00.000Z'

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(FIXED_TIME) })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  vi.unstubAllGlobals()
})

const makeRun = (overrides: Partial<ApiRun> = {}): ApiRun => ({
  id: 'r-activity',
  title: 'Activity header test',
  workflow: 'quick-task',
  task: 'Activity header test',
  status: RUN_STATUS.running,
  createdAt: FIXED_TIME,
  tokensUsed: 1200,
  costUsd: 0.42,
  archived: false,
  runner: 'claude',
  steps: [
    { id: 'task', name: 'Implement changes', kind: STEP_KIND.agent, status: STEP_STATUS.running, iterations: 1, tokensUsed: 1200 },
  ],
  currentStepId: 'task',
  ...overrides,
})

const subagentEvents: RunEvent[] = [
  {
    seq: 1,
    ts: FIXED_TIME,
    runId: 'r-activity',
    type: 'item.completed',
    stepId: 'task',
    item: { kind: 'tool', id: 'agent_1', name: 'Task', toolKind: 'task', title: 'Task: Scan routes', status: TOOL_STATUSES[0] },
  },
] as RunEvent[]

function wrap(ui: React.ReactElement) {
  return (
    <QueryClientProvider client={seedRunners(createQueryClient())}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

describe('run-activity-header (hearsay-tools/squawk#4374)', () => {
  it('renders desktop header trigger with status, active step, subagent badge and opens popover', () => {
    const onOpenChange = vi.fn()
    const thread = reduceThread(subagentEvents)
    render(wrap(
      <DesktopActivityHeaderControl
        run={makeRun()}
        thread={thread}
        currentThread={thread}
        currentComplete
        onOpenWorker={() => {}}
        mode="popover"
        open={false}
        onOpenChange={onOpenChange}
      />,
    ))
    const trigger = screen.getByRole('button', { name: /^Session activity: Running/ })
    expect(trigger.dataset.slot).toBe('run-activity-trigger')
    expect(trigger.dataset.activityMode).toBe('popover')
    expect(trigger.querySelector('[data-slot="run-activity-status"]')?.textContent).toBe('Running')
    expect(trigger.querySelector('[data-slot="activity-subagents-badge"]')?.textContent).toBe('0/1 agents')
    fireEvent.click(trigger)
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  it('toggles ultra-wide sidebar directly without rendering a popover wrapper', () => {
    const onOpenChange = vi.fn()
    const thread = reduceThread([])
    render(wrap(
      <DesktopActivityHeaderControl
        run={makeRun({ status: RUN_STATUS.done, steps: [{ id: 'task', name: 'Done', kind: STEP_KIND.agent, status: STEP_STATUS.done, iterations: 1, tokensUsed: 0 }] })}
        thread={thread}
        currentThread={thread}
        currentComplete
        onOpenWorker={() => {}}
        mode="sidebar"
        open
        onOpenChange={onOpenChange}
      />,
    ))
    expect(ULTRAWIDE_ACTIVITY_QUERY).toBe('(min-width: 1600px)')
    const trigger = screen.getByRole('button', { name: /All complete.*toggle activity sidebar/ })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(trigger)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('reports Incomplete on a done run with a failed step', () => {
    const thread = reduceThread([])
    render(wrap(
      <DesktopActivityHeaderControl
        run={makeRun({
          status: RUN_STATUS.done,
          steps: [{ id: 'task', name: 'Do the task', kind: STEP_KIND.agent, status: STEP_STATUS.failed, iterations: 1, tokensUsed: 0 }],
        })}
        thread={thread}
        currentThread={thread}
        currentComplete
        onOpenWorker={() => {}}
        mode="popover"
        open={false}
        onOpenChange={() => {}}
      />,
    ))
    expect(document.querySelector('[data-slot="run-activity-status"]')?.textContent).toBe('Incomplete')
  })

  it('renders mobile 44px Activity strip without a desktop pill slot', () => {
    const thread = reduceThread(subagentEvents)
    render(wrap(
      <MobileActivityHeaderControl
        run={makeRun()}
        thread={thread}
        currentThread={thread}
        currentComplete
        onOpenWorker={() => {}}
        mode="popover"
        open={false}
        onOpenChange={() => {}}
      />,
    ))
    const trigger = screen.getByRole('button', { name: /^Session activity: Running/ })
    expect(trigger.dataset.slot).toBe('run-activity-trigger-mobile')
    expect(trigger.className).toContain('min-h-11')
    expect(trigger.querySelector('[data-slot="pill"]')).toBeNull()
  })
})
