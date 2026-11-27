import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { RunStatus, StepState, StepStatus } from '@open-mercato/cezar-api-client'

import { activeStepIndex, railProgress, railSteps, railVisual, StepRail, type RailRun, type RailVisual } from './step-rail'

afterEach(cleanup)

/** A store-shaped step (`RunRecord.steps` entry) with sensible defaults. */
const step = (id: string, status: StepStatus, extra: Partial<StepState> = {}): StepState => ({
  id,
  name: id,
  kind: STEP_KIND.agent,
  status,
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

describe('railVisual — the full StepStatus → glyph table', () => {
  it.each<[StepStatus, RailVisual]>([
    ['done', 'done'],
    ['running', 'active'],
    ['waiting', 'active'], // paused mid-step: still the live one
    ['review', 'active'], // parked at the gate: in flight until accepted
    ['failed', 'failed'],
    ['cancelled', 'failed'],
    ['pending', 'pending'],
    ['skipped', 'pending'], // never ran — the empty circle is honest
  ])('%s → %s', (status, visual) => {
    expect(railVisual(status)).toBe(visual)
  })
})

describe('railProgress — (terminal + 0.5·active) / total', () => {
  it.each<[string, StepStatus[], number]>([
    ['no steps', [], 0],
    ['all pending', ['pending', 'pending'], 0],
    ['one running of two (the mockup state)', ['running', 'pending'], 0.25],
    ['done + running + pending', ['done', 'running', 'pending'], 0.5],
    ['waiting and review are active too', ['done', 'waiting', 'review', 'pending'], 0.5],
    ['terminal failures still advance the bar', ['done', 'failed'], 1],
    ['skipped and cancelled are terminal', ['skipped', 'cancelled'], 1],
    ['all done', ['done', 'done'], 1],
  ])('%s → %d', (_name, statuses, fraction) => {
    expect(railProgress(statuses.map((status, i) => step(`s${i}`, status)))).toBe(fraction)
  })
})

describe('StepRail', () => {
  it('shows a plugin kind and falls back to the stored kind', () => {
    render(<StepRail steps={[
      step('deploy', 'done', { kind: STEP_KIND.plugin, pluginKind: 'deploy' }),
      step('unknown', 'pending', { kind: STEP_KIND.plugin }),
    ]} />)
    expect(screen.getByText('deploy · step 1 of 2')).toBeTruthy()
    expect(screen.getByText('plugin · step 2 of 2')).toBeTruthy()
  })

  it('renders nothing without steps (worktree-less oddities stay honest)', () => {
    render(<StepRail steps={[]} />)
    expect(document.querySelector('[data-slot="step-rail"]')).toBeNull()
  })

  it('one row per step with the mapped glyph, name, kind and position', () => {
    render(
      <StepRail
        steps={[
          step('implement', 'done', { name: 'Do the task' }),
          step('verify', 'running', { name: 'Verify', kind: STEP_KIND.check }),
          step('review', 'pending', { name: 'Review' }),
        ]}
      />,
    )
    const rows = [...document.querySelectorAll('[data-slot="step-row"]')]
    expect(rows.map((row) => row.getAttribute('data-visual'))).toEqual(['done', 'active', 'pending'])
    expect(rows[0]!.textContent).toContain('Do the task')
    expect(rows[0]!.textContent).toContain('agent · step 1 of 3')
    expect(rows[1]!.textContent).toContain('check · step 2 of 3')
    // The amber spinner announces itself; done/pending rows carry no live status.
    expect(screen.getAllByRole('status', { name: 'Step running' })).toHaveLength(1)
  })

  it('draws the live step of a waiting run as a still paused dot, not a spinner', () => {
    render(<StepRail runStatus="waiting" steps={[step('implement', 'done', { name: 'Do the task' }), step('verify', 'running', { name: 'Verify' })]} />)
    const rows = [...document.querySelectorAll('[data-slot="step-row"]')]
    expect(rows.map((row) => row.getAttribute('data-visual'))).toEqual(['done', 'paused'])
    expect(screen.getByRole('img', { name: 'Step paused' }).getAttribute('class')).not.toContain('animate-spin')
    expect(screen.queryAllByRole('status', { name: 'Step running' })).toEqual([])
  })

  it('marks a failed step failed on its row', () => {
    render(<StepRail steps={[step('t', 'failed', { name: 'Do the task' })]} />)
    expect(document.querySelector('[data-slot="step-row"]')?.getAttribute('data-visual')).toBe('failed')
  })

  it('shows ×N only when a step actually iterated', () => {
    render(
      <StepRail
        steps={[step('a', 'done', { iterations: 3 }), step('b', 'done')]}
      />,
    )
    const marks = [...document.querySelectorAll('[data-slot="step-iterations"]')]
    expect(marks).toHaveLength(1)
    expect(marks[0]!.textContent).toBe('×3')
  })

  it('draws the thin progress bar at the formula width', () => {
    render(<StepRail steps={[step('a', 'done'), step('b', 'running'), step('c', 'pending'), step('d', 'pending')]} />)
    const bar = document.querySelector<HTMLElement>('[data-slot="step-progress"] > div')!
    expect(bar.style.width).toBe('37.5%') // (1 + 0.5) / 4
  })
})

describe('activeStepIndex — who the Workflow row speaks for', () => {
  it('points at the first in-flight step, else the last (a finished run reads "N of N")', () => {
    expect(activeStepIndex(undefined, [step('a', 'done'), step('b', 'running'), step('c', 'pending')])).toBe(1)
    expect(activeStepIndex(undefined, [step('a', 'done'), step('b', 'done')])).toBe(1)
    expect(activeStepIndex(undefined, [step('a', 'pending'), step('b', 'pending')])).toBe(0)
    // An empty list has no index to point at; 0 keeps `steps[index]` undefined rather than
    // handing back a -1 that would silently address the wrong element.
    expect(activeStepIndex(undefined, [])).toBe(0)
  })

  // hearsay-tools/cezarion#1478 review: a skipped step never runs, so it is not the next step.
  it('passes over a skipped step to the next one still to run', () => {
    expect(activeStepIndex(undefined, [step('a', 'done'), step('b', 'skipped'), step('c', 'pending')])).toBe(2)
  })

  // hearsay-tools/squawk#2589: a Continue step stays `waiting` while a later one runs.
  const continued = [...Array.from({ length: 7 }, (_, i) => step(`s${i + 1}`, 'waiting')), step('s8', 'running')]

  it("follows the run's current step past the earlier parked steps", () => {
    expect(activeStepIndex('s8', continued)).toBe(7)
  })

  it('names the last active step when the run names none', () => {
    expect(activeStepIndex(undefined, continued)).toBe(7)
    expect(activeStepIndex('gone', continued)).toBe(7)
  })

  it('names the last step that ran when a finished run names none', () => {
    expect(activeStepIndex(undefined, [step('a', 'done'), step('b', 'cancelled'), step('c', 'skipped')])).toBe(1)
  })
})

describe('railSteps — a finished run draws no live step (hearsay-tools/squawk#2589)', () => {
  const steps = [step('a', 'done'), step('b', 'waiting'), step('c', 'running'), step('d', 'review'), step('e', 'pending')]
  const statuses = (run: RailRun) => railSteps(run).map((s) => s.status)

  it.each<[RunStatus, StepStatus]>([
    ['done', 'done'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ])('a %s run settles its open steps to its outcome and its unreached steps to skipped', (status, outcome) => {
    expect(statuses({ status, steps })).toEqual(['done', outcome, outcome, outcome, 'skipped'])
    expect(railProgress(railSteps({ status, steps }))).toBe(1)
  })

  it.each<RunStatus>(['queued', 'running', 'waiting', 'review'])('a %s run keeps one live step', (status) => {
    expect(statuses({ status, steps })).toEqual(['done', 'done', 'running', 'review', 'pending'])
  })

  it('a live run with no parked earlier turn keeps its steps as stored', () => {
    const live = [step('a', 'done'), step('b', 'running'), step('c', 'pending')]
    expect(railSteps({ status: RUN_STATUS.running, steps: live })).toBe(live)
  })
})

describe('railSteps — a live run draws only its current turn as running', () => {
  const statuses = (run: RailRun) => railSteps(run).map((s) => s.status)
  // The shape the server stores: each Continue leaves the turn it resumes `waiting`.
  const parked = [step('task', 'waiting'), step('continue-1', 'waiting'), step('continue-2', 'waiting'), step('continue-3', 'running')]

  it('draws the earlier parked turns as done and the current step as running', () => {
    expect(statuses({ status: RUN_STATUS.running, currentStepId: 'continue-3', steps: parked })).toEqual(['done', 'done', 'done', 'running'])
  })

  it('a parked run keeps its current waiting step live', () => {
    const waiting = parked.map((s) => s.id === 'continue-3' ? { ...s, status: STEP_STATUS.waiting } : s)
    const drawn = railSteps({ status: RUN_STATUS.waiting, currentStepId: 'continue-3', steps: waiting })
    expect(drawn.map((s) => railVisual(s.status))).toEqual(['done', 'done', 'done', 'active'])
    render(<StepRail steps={drawn} />)
    expect(screen.getAllByRole('status', { name: 'Step running' })).toHaveLength(1)
  })

  it('without currentStepId the last active step stays live', () => {
    expect(statuses({ status: RUN_STATUS.waiting, steps: parked.slice(0, 3) })).toEqual(['done', 'done', 'waiting'])
  })

  it('a later workflow step still to run stays pending', () => {
    const steps = [step('task', 'waiting'), step('continue-1', 'running'), step('verify', 'pending')]
    expect(statuses({ status: RUN_STATUS.running, currentStepId: 'continue-1', steps })).toEqual(['done', 'running', 'pending'])
  })
})
