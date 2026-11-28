import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TaskTelemetryPopover } from '@/components/task-telemetry-popover'
import { resolveVisibleColumns, TaskTableRow } from '@/components/task-table'
import type { GlobalTask } from '@/lib/global-tasks'
import { normalizeExpandedColumns } from '@/lib/task-columns'
import { globalTaskToTaskModel } from '@/lib/task-model'

vi.mock('@/components/task-telemetry-popover', async (original) => ({
  ...(await original<typeof import('@/components/task-telemetry-popover')>()),
  TaskTelemetryPopover: vi.fn(() => <button type="button">Usage</button>),
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-06T10:01:00Z'))
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

it('skips unchanged summaries even when the index projection wrapper is recreated', () => {
  const now = Date.now()
  const task: GlobalTask = {
    run: {
      id: 'one',
      projectId: 'boot',
      title: 'First title',
      status: RUN_STATUS.running,
      createdAt: '2026-11-06T10:00:00Z',
      archived: false,
      workflow: 'quick-task',
      workflowLabel: 'Quick task',
      tokensUsed: 0,
    },
    project: undefined,
    projectName: 'Boot',
    tags: [],
  }
  const columns = resolveVisibleColumns(normalizeExpandedColumns(undefined), false)
  const onArchive = vi.fn()
  const onSetRead = vi.fn()
  const onTogglePin = vi.fn()
  const row = (value: GlobalTask) => (
    <MemoryRouter>
      <TooltipProvider>
        <TaskTableRow
          model={globalTaskToTaskModel({ task: value, now })}
          rowIndex={2}
          columns={columns}
          gridTemplate="minmax(0, 1fr) 112px 104px 128px 72px"
          now={now}
          scoped={false}
          showProject
          allowRename={false}
          showTokens
          showCost
          liveUsageSource="snapshot"
          compact={false}
          onTogglePin={onTogglePin}
          onSetRead={onSetRead}
          onArchive={onArchive}
          busy={false}
          rowSlot="global-task-row"
        />
      </TooltipProvider>
    </MemoryRouter>
  )
  const view = render(row(task))
  expect(TaskTelemetryPopover).toHaveBeenCalledTimes(1)
  view.rerender(row({ ...task }))
  expect(TaskTelemetryPopover).toHaveBeenCalledTimes(1)
  view.rerender(row({ ...task, run: { ...task.run, title: 'Updated title' } }))
  expect(TaskTelemetryPopover).toHaveBeenCalledTimes(2)
})
