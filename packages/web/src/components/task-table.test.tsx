import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunSummary } from '@open-mercato/cezar-api-client'
import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { WAIT_KIND } from '@open-mercato/cezar-api-client/contract/wait-factories.testkit'
import { normalizeExpandedColumns } from '@/lib/task-columns'
import { globalTaskToTaskModel, projectRunToTaskModel } from '@/lib/task-model'
import { RUNNERS_RESPONSE } from '@/test/runners.testkit'
import { TaskTable } from './task-table'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-27T10:15:00.000Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function makeRun(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'run-1',
    title: 'Unify task lists',
    status: RUN_STATUS.waiting,
    waitingOn: { kind: WAIT_KIND.human, shown: true },
    statePreview: { kind: 'ask', text: 'Use popover or inline Usage column?' },
    createdAt: '2026-11-27T10:00:00.000Z',
    startedAt: '2026-11-27T10:00:00.000Z',
    archived: false,
    workflow: 'dev-flow',
    workflowLabel: 'dev-flow',
    runner: 'claude',
    model: 'opus-4.6',
    branch: 'feat/unified-task-table',
    diffStat: { adds: 120, dels: 30, files: 4 },
    inputTokens: 80_000,
    outputTokens: 20_000,
    costUsd: 0.35,
    tokensUsed: 100_000,
    ...over,
  }
}

function renderWithRouter(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('TaskTable', () => {
  const now = Date.parse('2026-11-27T10:15:00.000Z')

  it('renders table density with urgent 1-line preview, runner/model, no Direct task, and explicit Usage popover', () => {
    const direct = projectRunToTaskModel({ run: makeRun(), runners: RUNNERS_RESPONSE, now })
    const auto = projectRunToTaskModel({
      run: makeRun({ id: 'run-2', title: 'Nightly scan', status: RUN_STATUS.review, statePreview: { kind: 'review', text: '3 checks passed' }, automationId: 'auto-1' }),
      runners: RUNNERS_RESPONSE,
      automationName: () => 'security-scan',
      now,
    })

    const { container } = renderWithRouter(
      <TaskTable
        items={[direct, auto]}
        density="table"
        now={now}
        liveUsageSource="snapshot"
        showReferences={false}
      />,
    )

    expect(container.textContent).not.toContain('Direct task')
    expect(screen.getByText('Use popover or inline Usage column?')).toBeTruthy()
    expect(screen.getByText('3 checks passed')).toBeTruthy()
    expect(screen.getByText('security-scan')).toBeTruthy()
    expect(screen.getAllByText('Claude Code · opus-4.6')).toHaveLength(2)

    const usageBtn = screen.getByRole('button', { name: 'Usage and telemetry for Unify task lists' })
    expect(usageBtn.textContent).toContain('100.0k · $0.35')
    fireEvent.click(usageBtn)
    expect(screen.getByText('Task telemetry')).toBeTruthy()
    expect(screen.getByText('feat/unified-task-table')).toBeTruthy()
  })

  it('respects column visibility choices (Branch, Runner, Usage) in table and compact densities', () => {
    const item = projectRunToTaskModel({ run: makeRun(), runners: RUNNERS_RESPONSE, now })
    const { container } = renderWithRouter(
      <TaskTable
        items={[item]}
        density="compact"
        now={now}
        liveUsageSource="snapshot"
        showReferences={false}
        expandedColumns={normalizeExpandedColumns({ branch: true, runner: true, usage: false })}
      />,
    )
    const headers = [...container.querySelectorAll('[role="columnheader"]')].map((el) => el.textContent)
    expect(headers).toEqual(['Task', 'Runner', 'Workflow', 'Branch', 'Changes', 'Started'])
    expect(screen.getByText('feat/unified-task-table')).toBeTruthy()
  })

  it('renders card density with project badge and pinning for Global Tasks', () => {
    const onTogglePin = vi.fn()
    const globalItem = globalTaskToTaskModel({
      task: {
        run: { ...makeRun({ id: 'g1', pinned: false }), projectId: 'squawk' },
        project: undefined,
        projectName: 'squawk',
        tags: [],
      },
      runners: RUNNERS_RESPONSE,
      now,
    })

    const { container } = renderWithRouter(
      <TaskTable
        items={[globalItem]}
        density="card"
        now={now}
        scopedLinks={false}
        showProject
        liveUsageSource="snapshot"
        onTogglePin={onTogglePin}
      />,
    )

    expect(container.querySelector('[data-density="card"]')).not.toBeNull()
    expect(screen.getByText('squawk')).toBeTruthy()
    expect(screen.getByText('Use popover or inline Usage column?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Pin task' }))
    expect(onTogglePin).toHaveBeenCalledWith(globalItem, true)
  })
})
