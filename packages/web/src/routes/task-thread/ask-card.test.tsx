import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/client'
import { createQueryClient } from '@/api/query-client'
import { seedRunners } from '@/test/runners.testkit'
import { AskCard } from './ask-card'
import type { ThreadAsk } from './thread-state'
import type { ApiRun, ProviderStatusResponse, StepState } from '@open-mercato/cezar-api-client'

const mutateAsync = vi.fn().mockResolvedValue({})
const continueAsync = vi.fn().mockResolvedValue({})
let providerStatus: ProviderStatusResponse
vi.mock('@/api/queries', () => ({
  useSendMessage: () => ({ mutateAsync, isPending: false }),
  useContinueRun: () => ({ mutateAsync: continueAsync, isPending: false }),
  useProviderStatus: () => ({ data: providerStatus, isSuccess: true }),
}))

// The thread's provider gate also reads the run's agent account; these tests use the default account.
vi.mock('@/api/agent-accounts', () => ({
  useAgentAccounts: () => ({ accounts: [], repoAccount: undefined }),
}))

afterEach(cleanup)

beforeEach(() => {
  mutateAsync.mockClear().mockResolvedValue({})
  continueAsync.mockClear().mockResolvedValue({})
  providerStatus = {
    providers: [
      { provider: 'claude', status: 'connected', enabled: true },
      { provider: 'codex', status: 'not-installed', enabled: true },
      { provider: 'opencode', status: 'not-installed', enabled: true },
    ],
  }
})

const activeRun: ApiRun = {
  id: 'r1',
  title: 'Task',
  workflow: 'quick-task',
  task: 'Task',
  status: RUN_STATUS.waiting,
  createdAt: '2026-07-24T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  runner: 'claude',
  steps: [],
}

const step = (extra: Partial<StepState> = {}): StepState => ({
  id: 'task',
  name: 'Do the task',
  kind: STEP_KIND.agent,
  status: STEP_STATUS.done,
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

/** The run the feature exists for: the session closed while the question was unanswered. */
const closedRun: ApiRun = {
  ...activeRun,
  status: RUN_STATUS.done,
  steps: [step({ sessionId: 'sess-1' })],
}

/** The runners list is in the cache, as the app shell leaves it before a task opens. */
const withRunners = (ui: ReactNode) => (
  <QueryClientProvider client={seedRunners(createQueryClient())}>{ui}</QueryClientProvider>
)

const renderAsk = (ask: ThreadAsk, run: ApiRun = activeRun) => render(withRunners(
  <MemoryRouter>
    <AskCard ask={ask} run={run} />
  </MemoryRouter>,
))

const singleAsk: ThreadAsk = {
  kind: 'ask',
  id: 'ask_1',
  resolved: false,
  questions: [
    {
      header: 'Library',
      question: 'Which date library should I standardize on?',
      options: [
        { label: 'date-fns', description: 'Tree-shakeable' },
        { label: 'Luxon', description: 'Immutable, tz-aware' },
      ],
    },
  ],
}

it('hides Other for native option-only questions and still delivers an offered answer', async () => {
  const native: ThreadAsk = { ...singleAsk, questions: singleAsk.questions.map(question => ({ ...question, allowFreeText: false })) }
  renderAsk(native)
  expect(screen.queryByRole('button', { name: 'Other' })).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
  await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
  expect(JSON.stringify(mutateAsync.mock.calls)).toContain('Library: date-fns')
})

it('spans Other across both columns only when it would sit alone in its row', () => {
  const { unmount } = renderAsk(singleAsk)
  // Two options fill the first row, so Other takes the whole second row.
  expect(screen.getByRole('button', { name: 'Other' }).className).toContain('sm:col-span-2')
  unmount()
  renderAsk({ ...singleAsk, questions: singleAsk.questions.map(question => ({ ...question, options: [...(question.options ?? []), { label: 'Temporal' }] })) })
  expect(screen.getByRole('button', { name: 'Other' }).className).not.toContain('sm:col-span-2')
})

const multiAsk: ThreadAsk = {
  kind: 'ask',
  id: 'ask_2',
  resolved: false,
  questions: [
    {
      header: 'Sections',
      question: 'Which settings sections?',
      multiSelect: true,
      options: [{ label: 'Profile' }, { label: 'Appearance' }, { label: 'Billing' }],
    },
  ],
}

const twoQuestionAsk: ThreadAsk = {
  kind: 'ask',
  id: 'ask_3',
  resolved: false,
  questions: [
    {
      header: 'Library',
      question: 'Which library?',
      options: [{ label: 'date-fns' }, { label: 'Luxon' }],
    },
    {
      header: 'Style',
      question: 'Which style?',
      options: [{ label: 'ISO' }, { label: 'Relative' }],
    },
  ],
}

describe('AskCard', () => {
  it('a single single-select question sends "header: label" on one tap (no Send button)', () => {
    renderAsk(singleAsk)
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: date-fns' })
  })

  it('multiple questions: stepped 1 of N posts every answer in one combined message and preserves drafts across steps', () => {
    renderAsk(twoQuestionAsk)
    expect(document.querySelector('[data-slot="ask-step-indicator"]')?.textContent).toBe('1 of 2')
    // Answering only the first question does NOT send, and does not resolve.
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    expect(mutateAsync).not.toHaveBeenCalled()
    // Advance to question 2; Send stays disabled until question 2 is answered.
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(document.querySelector('[data-slot="ask-step-indicator"]')?.textContent).toBe('2 of 2')
    expect((screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement).disabled).toBe(true)
    // Going back keeps question 1's selection intact.
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(screen.getByRole('button', { name: /date-fns/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    // Both answered → one combined message.
    fireEvent.click(screen.getByRole('button', { name: /Relative/ }))
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(mutateAsync).toHaveBeenCalledTimes(1)
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: date-fns\nStyle: Relative' })
  })

  it('combines a chip answer and per-question Other text in one message across steps', () => {
    renderAsk(twoQuestionAsk)
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    const styleQuestion = screen.getByRole('group', { name: 'Which style?' })
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement

    fireEvent.click(within(styleQuestion).getByRole('button', { name: 'Other' }))
    const answer = within(styleQuestion).getByRole('textbox', { name: 'Your answer' })
    expect(send.disabled).toBe(true)

    fireEvent.change(answer, { target: { value: '   ' } })
    expect(send.disabled).toBe(true)
    fireEvent.change(answer, { target: { value: 'A short custom style' } })
    // Navigating back and forward preserves the Other draft.
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(screen.getByRole('textbox', { name: 'Your answer' })).toHaveProperty('value', 'A short custom style')
    expect((screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))

    expect(mutateAsync).toHaveBeenCalledWith({
      text: 'Library: date-fns\nStyle: A short custom style',
    })
  })

  it('a single single-select question sends Other text with an explicit Send', () => {
    renderAsk(singleAsk)

    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), {
      target: { value: 'A custom library' },
    })
    expect(send.disabled).toBe(false)
    fireEvent.click(send)

    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: A custom library' })
  })

  it('a multi-select question accepts Other text without a chip selection', () => {
    renderAsk(multiAsk)

    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), {
      target: { value: 'Only the account summary' },
    })
    expect(send.disabled).toBe(false)
    fireEvent.click(send)

    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Sections: Only the account summary' })
  })

  it('keeps a custom answer in the field when delivery fails', async () => {
    mutateAsync.mockRejectedValueOnce(new Error('temporary failure'))
    renderAsk(twoQuestionAsk)

    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    const styleQuestion = screen.getByRole('group', { name: 'Which style?' })
    fireEvent.click(within(styleQuestion).getByRole('button', { name: 'Other' }))
    const answer = within(styleQuestion).getByRole('textbox', { name: 'Your answer' })
    fireEvent.change(answer, { target: { value: 'A short custom style' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))

    expect((await screen.findByRole('alert')).textContent).toBe('temporary failure')
    expect(answer).toHaveProperty('value', 'A short custom style')
  })

  it('multi-select: Send is disabled until options are picked, then sends the comma-joined labels', () => {
    renderAsk(multiAsk)
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Profile/ }))
    fireEvent.click(screen.getByRole('button', { name: /Billing/ }))
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Sections: Profile, Billing' })
  })

  it('a resolved ask keeps the question and options with no answer controls', () => {
    renderAsk({ ...singleAsk, resolved: true, answer: 'Library: date-fns' })
    expect(screen.getByText('Answered')).toBeTruthy()
    expect(screen.getByText(singleAsk.questions[0]!.question)).toBeTruthy()
    expect(screen.getByText('date-fns').closest('[data-selected]')?.getAttribute('data-selected')).toBe('true')
    expect(screen.getByText('Luxon')).toBeTruthy()
    expect(screen.getByText('Tree-shakeable')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /date-fns/ })).toBeNull()
  })

  it.each([
    ['disabled', { provider: 'claude', status: 'connected', enabled: false }, 'Claude Code is disabled. Enable it in Settings → Agent defaults → Providers.'],
    ['disconnected', { provider: 'claude', status: 'disconnected', enabled: true }, 'Claude Code credentials are unavailable. Authorize it in Settings → Agent defaults → Providers.'],
  ] as const)('disables Ask submissions when its active provider is %s', (_case, claude, reason) => {
    providerStatus = {
      providers: [
        claude,
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    }

    renderAsk(singleAsk)

    expect((screen.getByRole('button', { name: /date-fns/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(reason)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Configure providers' }).getAttribute('href')).toBe(
      '/settings/agent-defaults#providers',
    )
    expect(mutateAsync).not.toHaveBeenCalled()
  })
})

describe('AskCard — unified decision surface (hearsay-tools/squawk#4374)', () => {
  it('embeds free-text reply as a mode inside the decision surface and preserves drafts across switches', () => {
    render(withRunners(
      <MemoryRouter>
        <AskCard ask={{ ...twoQuestionAsk, placement: 'pinned' }} run={activeRun} surface="decision-zone" />
      </MemoryRouter>,
    ))
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Write a reply' }))
    expect(document.querySelector('[data-slot="ask-card"]')?.getAttribute('data-ask-mode')).toBe('reply')
    const box = screen.getByRole('textbox', { name: 'Reply to the agent' })
    fireEvent.change(box, { target: { value: 'Let us take a third path' } })
    // Switch back to Options: selection is still there, and switching back to Reply retains the draft.
    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    expect(screen.getByRole('button', { name: /date-fns/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Write a reply' }))
    expect(screen.getByRole('textbox', { name: 'Reply to the agent' })).toHaveProperty('value', 'Let us take a third path')
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Let us take a third path' })
  })

  it('appends optional final comment step to multi-question answers and keeps progress dots non-interactive', () => {
    renderAsk(twoQuestionAsk)
    const dots = document.querySelector('[data-slot="ask-progress-dots"]')!
    expect(dots.querySelectorAll('button')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    fireEvent.click(screen.getByRole('tab', { name: /Style/ }))
    fireEvent.click(screen.getByRole('button', { name: /ISO/ }))
    fireEvent.click(screen.getByRole('button', { name: '+ Comment' }))
    expect(document.querySelector('[data-slot="ask-step-indicator"]')?.textContent).toBe('Comment (optional)')
    expect(document.querySelector('[data-slot="ask-comment-step"]')?.textContent).toContain('date-fns')
    expect(document.querySelector('[data-slot="ask-comment-step"]')?.textContent).toContain('ISO')
    fireEvent.change(screen.getByRole('textbox', { name: 'Additional comments (optional)' }), {
      target: { value: 'Keep UTC everywhere.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    expect(mutateAsync).toHaveBeenCalledWith({
      text: 'Library: date-fns\nStyle: ISO\n\nAdditional comments:\nKeep UTC everywhere.',
    })
  })

  it('opens Show context in a non-destructive sheet with a 44px Close control, restores focus on close, and offers Show where it was asked', () => {
    const onShowOrigin = vi.fn()
    render(withRunners(
      <MemoryRouter>
        <AskCard
          ask={{ ...twoQuestionAsk, placement: 'pinned', context: 'Full architectural rationale.' }}
          run={activeRun}
          surface="decision-zone"
          onShowOrigin={onShowOrigin}
        />
      </MemoryRouter>,
    ))
    // In decision-zone mode, context is behind Show context rather than bloating the fixed dock.
    expect(screen.queryByRole('region', { name: 'Context' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    const showContext = screen.getByRole('button', { name: /Show context/ })
    fireEvent.click(showContext)
    expect(screen.getByRole('region', { name: 'Context' }).textContent).toContain('Full architectural rationale.')
    const closeBtn = screen.getByRole('button', { name: 'Close' })
    expect(closeBtn.className).toContain('size-11')
    // Closing via Close restores focus to Show context while preserving selections.
    fireEvent.click(closeBtn)
    expect(screen.queryByRole('region', { name: 'Context' })).toBeNull()
    expect(document.activeElement).toBe(showContext)
    expect(screen.getByRole('button', { name: /date-fns/ }).getAttribute('aria-pressed')).toBe('true')
    // Reopening and choosing Show where it was asked invokes onShowOrigin with selection intact.
    fireEvent.click(showContext)
    fireEvent.click(screen.getByRole('button', { name: 'Show where it was asked' }))
    expect(onShowOrigin).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: /date-fns/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('supports optional comment on single-question asks and disables one-tap send while open', () => {
    renderAsk(singleAsk)
    fireEvent.click(screen.getByRole('button', { name: '+ Add comment' }))
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    expect(mutateAsync).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Additional comments (optional)' }), {
      target: { value: 'Prefer v4.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    expect(mutateAsync).toHaveBeenCalledWith({
      text: 'Library: date-fns\n\nAdditional comments:\nPrefer v4.',
    })
  })
})

describe('AskCard — answering after the session has ended', () => {
  it('a closed run resumes instead of replying, with the same answer text', async () => {
    renderAsk(singleAsk, closedRun)
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    await waitFor(() => expect(continueAsync).toHaveBeenCalledTimes(1))
    // No runner override: answering a question must not silently switch the run's engine.
    expect(continueAsync).toHaveBeenCalledWith({ text: 'Library: date-fns' })
    expect(mutateAsync).not.toHaveBeenCalled()
  })

  // The resume affordance must be identifiable without reading copy — and must NOT be claimed
  // by a live run's ordinary "pick one or more" hint, which sits in the same slot position.
  it('marks the delivery seam on the card, and only names the resume hint when resuming', () => {
    const { unmount } = renderAsk(twoQuestionAsk, activeRun)
    expect(document.querySelector('[data-slot="ask-card"]')?.getAttribute('data-delivery')).toBe('live')
    expect(document.querySelector('[data-slot="ask-resume-hint"]')).toBeNull()
    expect(document.querySelector('[data-slot="ask-progress-summary"]')).toBeTruthy()
    unmount()
    renderAsk(twoQuestionAsk, closedRun)
    expect(document.querySelector('[data-slot="ask-card"]')?.getAttribute('data-delivery')).toBe('resume')
    expect(document.querySelector('[data-slot="ask-resume-hint"]')).toBeTruthy()
  })

  it('combined Send on a closed run resumes once with every answer', async () => {
    renderAsk(twoQuestionAsk, closedRun)
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    fireEvent.click(screen.getByRole('button', { name: /Relative/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Send answer & reopen' }))
    await waitFor(() => expect(continueAsync).toHaveBeenCalledTimes(1))
    expect(continueAsync).toHaveBeenCalledWith({
      text: 'Library: date-fns\nStyle: Relative',
    })
  })

  it('a stale record that still claims a live session falls back to a resume on 409', async () => {
    // The cockpit's cached record says `waiting`; the server has already closed the session.
    mutateAsync.mockRejectedValueOnce(new ApiError(409, 'session closed'))
    renderAsk(singleAsk, { ...activeRun, steps: [step({ sessionId: 'sess-1' })] })
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    await waitFor(() => expect(continueAsync).toHaveBeenCalledTimes(1))
    expect(continueAsync).toHaveBeenCalledWith({ text: 'Library: date-fns' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('waits for idle teardown before retrying the continuation, without accepting a duplicate tap', async () => {
    mutateAsync.mockRejectedValueOnce(new ApiError(409, 'session closed'))
    let resolveContinuation: ((value: { continued: true }) => void) | undefined
    const continuation = new Promise<{ continued: true }>((resolve) => {
      resolveContinuation = resolve
    })
    continueAsync
      .mockRejectedValueOnce(new ApiError(409, 'run is still active'))
      .mockReturnValueOnce(continuation)
    renderAsk(singleAsk, { ...activeRun, steps: [step({ sessionId: 'sess-1' })] })

    const option = screen.getByRole('button', { name: /date-fns/ })
    fireEvent.click(option)
    await waitFor(() => expect(continueAsync).toHaveBeenCalledTimes(1))
    expect((option as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(option)

    await waitFor(() => expect(continueAsync).toHaveBeenCalledTimes(2))
    expect(continueAsync).toHaveBeenNthCalledWith(1, { text: 'Library: date-fns' })
    expect(continueAsync).toHaveBeenNthCalledWith(2, { text: 'Library: date-fns' })
    expect(mutateAsync).toHaveBeenCalledTimes(1)
    resolveContinuation?.({ continued: true })
    await waitFor(() => expect((option as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not silently switch to another connected provider when the run provider is unavailable', () => {
    providerStatus = {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    }

    renderAsk(singleAsk, closedRun)

    expect((screen.getByRole('button', { name: /date-fns/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(
      screen.getByText(
        'Claude Code credentials are unavailable. Authorize it in Settings → Agent defaults → Providers.',
      ),
    ).toBeTruthy()
    expect(continueAsync).not.toHaveBeenCalled()
  })

  it('a refused delivery is shown on the card instead of being dropped', async () => {
    continueAsync.mockRejectedValueOnce(new ApiError(409, 'no agent session to resume'))
    renderAsk(singleAsk, closedRun)
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    expect((await screen.findByRole('alert')).textContent).toBe('no agent session to resume')
  })

  it('a closed run that never recorded a session says so and stays inert', () => {
    renderAsk(singleAsk, { ...closedRun, steps: [step()] })
    expect((screen.getByRole('button', { name: /date-fns/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(
      screen.getByText(
        'This session has ended and no agent session was recorded, so the answer cannot be delivered.',
      ),
    ).toBeTruthy()
    expect(mutateAsync).not.toHaveBeenCalled()
    expect(continueAsync).not.toHaveBeenCalled()
  })
})

// hearsay-tools/cezarion#1234: a question without options is open; the user types the answer.
const openAsk: ThreadAsk = {
  kind: 'ask',
  id: 'ask_open',
  resolved: false,
  questions: [{ header: 'Name', question: 'What should the command be called?' }],
}

describe('AskCard — open questions', () => {
  it('shows a text field instead of choices and sends "header: text"', () => {
    renderAsk(openAsk)
    const question = screen.getByRole('group', { name: 'What should the command be called?' })
    // No chips and no Other toggle: the field is the answer.
    expect(within(question).queryByRole('button')).toBeNull()
    const answer = within(question).getByRole('textbox', { name: 'Your answer' })
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(answer, { target: { value: '   ' } })
    expect(send.disabled).toBe(true)
    fireEvent.change(answer, { target: { value: 'cez ask' } })
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Name: cez ask' })
  })

  it('beside a choice question, one Send answers both', () => {
    renderAsk({ ...openAsk, questions: [singleAsk.questions[0]!, openAsk.questions[0]!] })
    // The card is not one-tap any more: the chip only selects.
    fireEvent.click(screen.getByRole('button', { name: /date-fns/ }))
    expect(mutateAsync).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: 'cez ask' } })
    fireEvent.click(send)
    expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: date-fns\nName: cez ask' })
  })

  it('routed to the parent, it says the parent answers in words', () => {
    renderAsk({ ...openAsk, routedToParent: true, parentRunId: '11111111-2222-4333-8444-555555555555' })
    expect(screen.getByText('What should the command be called?')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.querySelector('[data-slot="ask-open-routed"]')).not.toBeNull()
  })
})

describe('AskCard for a worker question routed to its parent (#505)', () => {
  const parentId = '11111111-2222-4333-8444-555555555555'
  it('renders the question read-only with a link to the parent task', () => {
    renderAsk({ ...singleAsk, routedToParent: true, parentRunId: parentId })
    expect(screen.getByText('Which date library should I standardize on?')).toBeTruthy()
    expect(screen.getByText('date-fns')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /date-fns/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Send/ })).toBeNull()
    expect(screen.getByRole('link', { name: 'parent task' }).getAttribute('href')).toContain(`/tasks/${parentId}`)
    cleanup()
    render(withRunners(
      <MemoryRouter initialEntries={['/p/acme/tasks/worker']}>
        <AskCard ask={{ ...singleAsk, routedToParent: true, parentRunId: parentId }} run={activeRun} />
      </MemoryRouter>,
    ))
    expect(screen.getByRole('link', { name: 'parent task' }).getAttribute('href')).toBe(`/p/acme/tasks/${parentId}`)
    expect(document.querySelector('[data-slot="ask-routed-hint"]')?.textContent).toContain('Routed to parent')
  })

  it('shows the chips again once the question falls back to the human', () => {
    renderAsk({ ...singleAsk, routedToParent: false, parentRunId: parentId })
    expect(screen.getByRole('button', { name: /date-fns/ })).toBeTruthy()
    expect(document.querySelector('[data-slot="ask-routed-hint"]')).toBeNull()
  })

  it('says the parent answered it', () => {
    renderAsk({ ...singleAsk, resolved: true, answeredBy: 'parent' })
    expect(screen.getByText('Answered by parent')).toBeTruthy()
  })

  // hearsay-tools/cezarion#1260: a question Finish closed was never answered.
  it('says Finish closed a question nobody answered', () => {
    renderAsk({ ...singleAsk, resolved: true, closed: 'finish' })
    expect(screen.getByText('Closed when the task finished')).toBeTruthy()
    expect(screen.queryByText('Answered')).toBeNull()
  })

  // hearsay-tools/cezarion#2410: a worker question closes with its parent or itself, or is not delivered.
  it.each([
    ['parent-stopped', 'Closed when the parent stopped'],
    ['worker-stopped', 'Closed when the worker stopped'],
    ['undeliverable', 'Closed: not delivered'],
  ] as const)('says why a worker question closed (%s)', (closed, label) => {
    renderAsk({ ...singleAsk, resolved: true, closed })
    expect(screen.getByText(label)).toBeTruthy()
    expect(screen.queryByText('Answered')).toBeNull()
  })
})

// hearsay-tools/cezarion#1458: the agent's draft or findings, as Markdown above the questions.
describe('AskCard context', () => {
  const context = 'The plan has **two** steps.\n\n- parse\n- render'

  it('renders the full context in an agent response before the first question', () => {
    renderAsk({ ...singleAsk, context })
    const region = screen.getByRole('region', { name: 'Context' })
    expect(within(region).getByText('two').closest('[data-streamdown="strong"]')).not.toBeNull()
    expect(within(region).getAllByRole('listitem')).toHaveLength(2)
    const question = screen.getByText('Which date library should I standardize on?')
    expect(region.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders it on a card routed to the parent too', () => {
    renderAsk({ ...singleAsk, context, routedToParent: true, parentRunId: '11111111-2222-4333-8444-555555555555' })
    expect(within(screen.getByRole('region', { name: 'Context' })).getByText('two').closest('[data-streamdown="strong"]')).not.toBeNull()
  })

  it('keeps the context after answering and omits it only when absent', () => {
    renderAsk(singleAsk)
    expect(screen.queryByRole('region', { name: 'Context' })).toBeNull()
    expect(screen.getByText('Which date library should I standardize on?')).toBeTruthy()
    cleanup()
    renderAsk({ ...singleAsk, context, resolved: true, answer: 'Library: Luxon' })
    expect(screen.getByRole('region', { name: 'Context' })).toBeTruthy()
    expect(screen.getByText('Luxon').closest('[data-selected]')?.getAttribute('data-selected')).toBe('true')
  })
})

describe('answered question history', () => {
  it.each([
    ['Library: A custom library', 'A custom library'],
    ['Library: First line\nSecond line', 'First line\nSecond line'],
  ])('quotes Other replies: %s', (answer, text) => {
    renderAsk({ ...singleAsk, resolved: true, answer })
    expect(screen.getByText('Other')).toBeTruthy()
    expect(document.querySelector('blockquote')?.textContent).toBe(text)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('preserves multiple selections and matches whole labels containing commas', () => {
    renderAsk({ ...multiAsk, resolved: true, answer: 'Sections: Billing, Profile' })
    expect([...document.querySelectorAll('[data-selected="true"]')].map(row => row.textContent)).toEqual([
      expect.stringContaining('Profile'), expect.stringContaining('Billing'),
    ])
    cleanup()
    renderAsk({ ...multiAsk, questions: [{ ...multiAsk.questions[0]!, options: [{ label: 'A, B' }, { label: 'C' }] }], resolved: true, answer: 'Sections: A, B' })
    expect(screen.getByText('A, B').closest('[data-selected]')?.getAttribute('data-selected')).toBe('true')
  })

  it('keeps open replies and unmatched multi-question replies without guessing selections', () => {
    renderAsk({ ...singleAsk, questions: [{ header: 'Notes', question: 'Any notes?' }], resolved: true, answer: 'Notes: Keep the filters.' })
    expect(document.querySelector('blockquote')?.textContent).toBe('Keep the filters.')
    expect(screen.queryByText('Other')).toBeNull()
    cleanup()
    renderAsk({ ...twoQuestionAsk, resolved: true, answer: 'Please use the existing style.' })
    expect(document.querySelector('blockquote')?.textContent).toBe('Please use the existing style.')
    expect(document.querySelector('[data-selected="true"]')).toBeNull()
    expect(screen.getByText('Which library?')).toBeTruthy()
    expect(screen.getByText('Which style?')).toBeTruthy()
  })
})

it('clears a custom answer when its Other control closes and opens it empty on the next click', () => {
  renderAsk(singleAsk)
  const other = screen.getByRole('button', { name: 'Other' })
  fireEvent.click(other)
  const answer = screen.getByRole('textbox', { name: 'Your answer' })
  fireEvent.change(answer, { target: { value: 'Custom library' } })
  expect(other.getAttribute('aria-controls')).toBe(answer.id)
  expect(other.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(other)
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(other.getAttribute('aria-controls')).toBeNull()
  expect(other.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull()
  fireEvent.click(other)
  expect(screen.getByRole('textbox', { name: 'Your answer' })).toHaveProperty('value', '')
  expect(screen.getByRole('button', { name: 'Send answer' })).toHaveProperty('disabled', true)
  expect(mutateAsync).not.toHaveBeenCalled()
})

it('replaces Other with a chip without keeping the old custom answer', () => {
  renderAsk(twoQuestionAsk)
  const library = screen.getByRole('group', { name: 'Which library?' })
  fireEvent.click(within(library).getByRole('button', { name: 'Other' }))
  fireEvent.change(within(library).getByRole('textbox'), { target: { value: 'Discard this' } })
  fireEvent.click(within(library).getByRole('button', { name: 'Luxon' }))
  expect(within(library).queryByRole('textbox')).toBeNull()
  expect(within(library).getByRole('button', { name: 'Luxon' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: /Next/ }))
  fireEvent.click(screen.getByRole('button', { name: 'ISO' }))
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
  expect(mutateAsync).toHaveBeenCalledWith({ text: 'Library: Luxon\nStyle: ISO' })
})

it('deselects one multi-select option while retaining the other answer', () => {
  renderAsk(multiAsk)
  const profile = screen.getByRole('button', { name: 'Profile' })
  const billing = screen.getByRole('button', { name: 'Billing' })
  fireEvent.click(profile)
  fireEvent.click(billing)
  fireEvent.click(profile)
  expect(profile.getAttribute('aria-pressed')).toBe('false')
  expect(billing.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
  expect(mutateAsync).toHaveBeenCalledWith({ text: 'Sections: Billing' })
})

it('trims an open answer and keeps Send disabled for whitespace', () => {
  renderAsk({ ...singleAsk, questions: [{ header: 'Notes', question: 'Any notes?' }] })
  expect(screen.queryByRole('button', { name: 'Other' })).toBeNull()
  const send = screen.getByRole('button', { name: 'Send answer' })
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
  expect(send).toHaveProperty('disabled', true)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Keep the parser  ' } })
  expect(send).toHaveProperty('disabled', false)
  fireEvent.click(send)
  expect(mutateAsync).toHaveBeenCalledWith({ text: 'Notes: Keep the parser' })
})

it('replays structured answers with additional comments without demoting the chosen option to Other', () => {
  renderAsk({
    ...twoQuestionAsk,
    resolved: true,
    answer: 'Library: Luxon\nStyle: ISO\n\nAdditional comments:\nKeep the bundle small.',
  })
  const selected = [...document.querySelectorAll('[data-slot="ask-answers"] [data-selected="true"]')].map(
    (el) => el.textContent,
  )
  expect(selected.some((text) => text?.includes('Luxon'))).toBe(true)
  expect(selected.some((text) => text?.includes('ISO'))).toBe(true)
  expect(selected.some((text) => text?.includes('Other'))).toBe(false)
  expect(screen.getByText('Additional comments')).toBeTruthy()
  expect(screen.getByText('Keep the bundle small.')).toBeTruthy()
})
