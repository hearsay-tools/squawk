import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunSummary } from '@open-mercato/cezar-api-client'
import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { WAIT_KIND } from '@open-mercato/cezar-api-client/contract/wait-factories.testkit'
import type { GlobalTask } from '@/lib/global-tasks'
import { RUNNERS_RESPONSE } from '@/test/runners.testkit'
import { globalTaskToTaskModel, projectRunToTaskModel } from './task-model'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-27T10:15:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

function makeSummary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'run-1',
    title: 'Fix the thing',
    status: RUN_STATUS.running,
    createdAt: '2026-11-27T10:00:00.000Z',
    archived: false,
    workflow: 'quick-task',
    workflowLabel: 'quick-task',
    tokensUsed: 0,
    ...over,
  }
}

describe('task-model', () => {
  it('omits automationBadge for direct tasks and populates it for automation tasks', () => {
    const direct = projectRunToTaskModel({
      run: makeSummary({ id: 'r1', title: 'Manual fix', runner: 'claude', model: 'opus-4.6' }),
      runners: RUNNERS_RESPONSE,
    })
    expect(direct.automationBadge).toBeUndefined()
    expect(direct.runnerModel).toBe('Claude Code · opus-4.6')

    const auto = projectRunToTaskModel({
      run: makeSummary({ id: 'r2', title: 'Nightly audit', automationId: 'sec-1', runner: 'codex', model: 'gpt-6.1' }),
      runners: RUNNERS_RESPONSE,
      automationName: (id) => (id === 'sec-1' ? 'security-scan' : undefined),
    })
    expect(auto.automationBadge).toEqual({ id: 'sec-1', label: 'security-scan' })
    expect(auto.runnerModel).toBe('Codex · gpt-6.1')
  })

  it('derives urgent and failed 1-line statePreview with fallback', () => {
    const ask = projectRunToTaskModel({
      run: makeSummary({
        id: 'r-ask',
        status: RUN_STATUS.waiting,
        waitingOn: { kind: WAIT_KIND.human, shown: true },
        statePreview: { kind: 'ask', text: 'Approve schema migration?' },
      }),
    })
    expect(ask.urgent).toBe(true)
    expect(ask.statePreview).toEqual({ kind: 'ask', text: 'Approve schema migration?' })

    const reviewFallback = projectRunToTaskModel({
      run: makeSummary({ id: 'r-rev', status: RUN_STATUS.review }),
    })
    expect(reviewFallback.urgent).toBe(true)
    expect(reviewFallback.statePreview).toEqual({ kind: 'review', text: 'Ready for review' })

    const failed = projectRunToTaskModel({
      run: makeSummary({ id: 'r-err', status: RUN_STATUS.failed, error: 'Typecheck failed\non line 42' }),
    })
    expect(failed.statePreview).toEqual({ kind: 'error', text: 'Typecheck failed on line 42' })
  })

  it('formats explicit usage summary and projects global tasks with project metadata', () => {
    const globalTask: GlobalTask = {
      run: {
        ...makeSummary({
          id: 'r-global',
          title: 'Cross project work',
          pinned: true,
          inputTokens: 96_200,
          outputTokens: 27_800,
          costUsd: 0.42,
        }),
        projectId: 'squawk',
      },
      project: undefined,
      projectName: 'Squawk',
      tags: ['core'],
    }
    const model = globalTaskToTaskModel({ task: globalTask, runners: RUNNERS_RESPONSE })
    expect(model.key).toBe('squawk/r-global')
    expect(model.projectName).toBe('Squawk')
    expect(model.projectHref).toBe('/p/squawk/')
    expect(model.href).toBe('/p/squawk/tasks/r-global')
    expect(model.pinned).toBe(true)
    expect(model.usageSummary).toBe('124.0k · $0.42')
    expect(model.hasUsageData).toBe(true)
  })
})
