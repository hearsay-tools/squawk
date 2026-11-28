import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunStatus } from '@open-mercato/cezar-api-client'
import { ATTENTION_RUNGS } from '@open-mercato/cezar-api-client/contract/attention'
import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import {
  ARCHIVED_STATUS,
  CI_CHECK_PRESENTATION,
  DRY_RUN_MODE,
  SEMANTIC_TEXT_CLASS,
  STATUS_CATEGORIES,
  automationStatusPresentation,
  canonicalRungLabel,
  isDryRunVersion,
  providerStatusPresentation,
  rawRunStatusLabel,
  rawRunStatusPresentation,
  runStatusPresentation,
  rungPresentation,
  toolAvailabilityPresentation,
} from './status-semantics'

describe('status-semantics', () => {
  it('gives every attention rung a Sentence-case canonical label and semantic category', () => {
    for (const rung of ATTENTION_RUNGS) {
      const presentation = rungPresentation(rung)
      expect(presentation.label.length).toBeGreaterThan(0)
      expect(presentation.label[0]).toBe(presentation.label[0]?.toUpperCase())
      expect(STATUS_CATEGORIES).toContain(presentation.category)
      expect(SEMANTIC_TEXT_CLASS[presentation.tone]).toBeTruthy()
    }
    expect(rungPresentation('needs-review')).toMatchObject({
      category: 'review',
      label: 'Needs review',
      tone: 'info',
    })
    expect(rungPresentation('needs-you')).toMatchObject({
      category: 'attention',
      label: 'Needs you',
      tone: 'pending',
    })
    expect(rungPresentation('needs-permission')).toMatchObject({
      category: 'attention',
      label: 'Needs permission',
      tone: 'info',
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('distinguishes provider-error holds from usage-limit holds', () => {
    vi.useFakeTimers({ now: new Date('2026-11-27T12:00:00Z') })
    expect(canonicalRungLabel('usage-limit', 'usage limit')).toBe('Usage limit')
    expect(canonicalRungLabel('usage-limit', 'usage limit', 'provider-error')).toBe('Provider error')
    expect(
      runStatusPresentation({
        status: RUN_STATUS.waiting,
        autoResumeAt: new Date(Date.now() + 60_000).toISOString(),
        autoResumeReason: 'provider-error',
      }),
    ).toMatchObject({
      category: 'execution',
      label: 'Provider error',
      tone: 'neutral',
      shape: 'ring',
    })
  })

  it('normalizes dynamic worker wait phrasing to Sentence-case Waiting for', () => {
    expect(canonicalRungLabel('waiting-on-workers', 'waiting on 2 workers')).toBe('Waiting for 2 workers')
    expect(canonicalRungLabel('waiting-on-workers', 'waiting on parent reply')).toBe('Waiting for parent reply')
    expect(canonicalRungLabel('waiting-on-workers', 'waiting on 3 tasks')).toBe('Waiting for 3 tasks')
    expect(canonicalRungLabel('waiting-on-subagents', 'waiting for 2 subagents')).toBe('Waiting for 2 subagents')
  })

  it('maps every bare RunStatus enum to its canonical Sentence-case presentation without claiming Needs you for generic waiting', () => {
    const expected: Record<RunStatus, string> = {
      waiting: 'Waiting',
      review: 'Needs review',
      running: 'Running',
      queued: 'Queued',
      done: 'Done',
      failed: 'Failed',
      cancelled: 'Cancelled',
    }
    for (const [status, label] of Object.entries(expected) as [RunStatus, string][]) {
      expect(rawRunStatusLabel(status)).toBe(label)
      expect(rawRunStatusPresentation(status).label).toBe(label)
    }
    expect(rawRunStatusPresentation(RUN_STATUS.waiting)).toMatchObject({
      category: 'execution',
      label: 'Waiting',
      tone: 'pending',
      shape: 'ring',
      pulse: false,
    })
  })

  it('separates archive membership into its own neutral presentation', () => {
    expect(ARCHIVED_STATUS).toEqual({
      category: 'archive',
      label: 'Archived',
      tone: 'neutral',
      shape: 'filled',
      pulse: false,
    })
  })

  it('gives automations canonical repeating and one-time presentations', () => {
    expect(automationStatusPresentation({ enabled: true })).toMatchObject({ label: 'Enabled', tone: 'success' })
    expect(automationStatusPresentation({ enabled: false })).toMatchObject({ label: 'Paused', tone: 'neutral' })
    expect(automationStatusPresentation({ enabled: true, schedule: { type: 'once' }, onceStatus: 'waiting' })).toMatchObject({
      label: 'Scheduled',
      tone: 'running',
      shape: 'ring',
    })
    expect(automationStatusPresentation({ enabled: false, schedule: { type: 'once' }, onceStatus: 'missed' })).toMatchObject({
      category: 'attention',
      label: 'Missed',
      tone: 'pending',
    })
    expect(automationStatusPresentation({ enabled: false, schedule: { type: 'once' }, onceStatus: 'archived' })).toEqual(
      ARCHIVED_STATUS,
    )
  })

  it('separates dry-run capability mode from real CLI availability', () => {
    expect(isDryRunVersion('mock (HSQ_DRY_RUN=1)')).toBe(true)
    expect(isDryRunVersion('mock (CEZ_DRY_RUN=1)')).toBe(true)
    expect(isDryRunVersion('2.1.0')).toBe(false)

    const dryRun = toolAvailabilityPresentation({
      name: 'claude',
      available: true,
      version: 'mock (HSQ_DRY_RUN=1)',
    })
    expect(dryRun.availability).toMatchObject({
      category: 'capability',
      label: 'Simulated',
      tone: 'neutral',
      shape: 'ring',
    })
    expect(dryRun.mode).toEqual(DRY_RUN_MODE)
    expect(dryRun.version).toBeUndefined()
    expect(dryRun.rawVersion).toBe('mock (HSQ_DRY_RUN=1)')

    expect(toolAvailabilityPresentation({ name: 'claude', available: true, version: '2.1.0' })).toMatchObject({
      availability: { label: 'Installed', tone: 'success' },
      version: '2.1.0',
    })
    expect(toolAvailabilityPresentation({ name: 'claude', available: false }).availability).toMatchObject({
      label: 'Not installed',
      tone: 'neutral',
    })
    expect(toolAvailabilityPresentation({ name: 'git', available: false }).availability).toMatchObject({
      label: 'Not installed',
      tone: 'danger',
    })
  })

  it('unifies provider connection labels and CI check tones', () => {
    expect(providerStatusPresentation('connected')).toMatchObject({ label: 'Connected', tone: 'success' })
    expect(providerStatusPresentation('disconnected')).toMatchObject({ label: 'Not connected', tone: 'pending' })
    expect(providerStatusPresentation('not-installed')).toMatchObject({ label: 'Not installed', tone: 'neutral' })
    expect(providerStatusPresentation('unknown')).toMatchObject({ label: 'Could not verify', tone: 'danger' })

    expect(CI_CHECK_PRESENTATION.pending).toMatchObject({
      label: 'Checks pending',
      tone: 'pending',
      textClass: 'text-semantic-amber',
    })
  })
})
