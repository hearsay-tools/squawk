import { useId, useRef, type ReactNode, type RefObject } from 'react'
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, FileTextIcon, MessageSquareTextIcon } from 'lucide-react'
import { XIcon } from '@/components/design-icons'

import type { UiAskQuestion } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { Markdown } from './markdown'

export interface FreeTextReplyRenderProps {
  value: string
  onValueChange: (next: string) => void
  disabled: boolean
}

export function questionAnswered(
  index: number,
  selections: Readonly<Record<number, string[]>>,
  otherAnswers: Readonly<Record<number, string>>,
): boolean {
  const other = otherAnswers[index]
  if (other !== undefined) return other.trim().length > 0
  return (selections[index]?.length ?? 0) > 0
}

function questionSummaryText(
  index: number,
  selections: Readonly<Record<number, string[]>>,
  otherAnswers: Readonly<Record<number, string>>,
): string {
  const other = otherAnswers[index]?.trim()
  if (other) return other
  const labels = selections[index] ?? []
  return labels.length > 0 ? labels.join(', ') : 'Not answered yet'
}

export function PendingAskHeader({
  stepped,
  mode,
  onModeChange,
  showModeSwitch,
  stepLabel,
  hasSheetContext,
  showContextButtonRef,
  onOpenContext,
  onShowOrigin,
}: {
  stepped: boolean
  mode: 'options' | 'reply'
  onModeChange: (next: 'options' | 'reply') => void
  showModeSwitch: boolean
  stepLabel: string
  hasSheetContext: boolean
  showContextButtonRef?: RefObject<HTMLButtonElement | null> | undefined
  onOpenContext: () => void
  onShowOrigin: (() => void) | undefined
}) {
  return (
    <div
      data-slot="ask-header"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2"
    >
      <span className="text-xs font-semibold text-link-foreground">Needs your answer</span>
      {stepped && mode === 'options' ? (
        <span
          data-slot="ask-step-indicator"
          className="rounded-full bg-accent-strong/15 px-2 py-0.5 text-[11px] font-semibold text-foreground tabular-nums"
        >
          {stepLabel}
        </span>
      ) : null}

      <div className="ms-auto flex flex-wrap items-center gap-1.5">
        {hasSheetContext ? (
          <Button
            ref={showContextButtonRef}
            type="button"
            variant="ghost"
            size="sm"
            data-slot="ask-show-context"
            className="min-h-11 min-w-11 px-2 text-xs font-medium text-link-foreground underline underline-offset-4 md:min-h-8 md:min-w-0"
            onClick={onOpenContext}
          >
            <FileTextIcon aria-hidden="true" className="size-3.5" />
            Show context
          </Button>
        ) : onShowOrigin ? (
          <ShowOriginLink onShowOrigin={onShowOrigin} />
        ) : null}

        {showModeSwitch ? (
          <div
            data-slot="ask-mode-switch"
            role="group"
            aria-label="Reply mode"
            className="inline-flex items-center rounded-lg border border-border bg-card p-0.5"
          >
            <button
              type="button"
              data-slot="ask-mode-options"
              aria-pressed={mode === 'options'}
              onClick={() => onModeChange('options')}
              className={cn(
                'min-h-11 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring md:min-h-7',
                mode === 'options'
                  ? 'bg-accent-strong text-accent-strong-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Options
            </button>
            <button
              type="button"
              data-slot="ask-mode-reply"
              aria-pressed={mode === 'reply'}
              onClick={() => onModeChange('reply')}
              className={cn(
                'min-h-11 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring md:min-h-7',
                mode === 'reply'
                  ? 'bg-accent-strong text-accent-strong-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Write a reply
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function DesktopStepPills({
  questions,
  stepIndex,
  selections,
  otherAnswers,
  hasComment,
  onSelectStep,
}: {
  questions: readonly UiAskQuestion[]
  stepIndex: number
  selections: Readonly<Record<number, string[]>>
  otherAnswers: Readonly<Record<number, string>>
  hasComment: boolean
  onSelectStep: (index: number) => void
}) {
  const commentStepIndex = questions.length
  return (
    <div
      data-slot="ask-step-pills"
      role="tablist"
      aria-label="Question steps"
      className="hidden shrink-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-1.5 md:flex"
    >
      {questions.map((question, index) => {
        const active = stepIndex === index
        const answered = questionAnswered(index, selections, otherAnswers)
        return (
          <button
            key={question.id ?? index}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelectStep(index)}
            className={cn(
              'inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring',
              active
                ? 'border-accent-strong bg-accent-strong/15 text-foreground'
                : answered
                  ? 'border-border bg-card text-foreground hover:border-accent-strong/50'
                  : 'border-border bg-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <span className="tabular-nums text-[11px] font-semibold">
              {answered ? <CheckIcon aria-hidden="true" className="size-3 text-success" /> : `${index + 1}.`}
            </span>
            <span className="max-w-[140px] truncate">{question.header}</span>
          </button>
        )
      })}
      <button
        type="button"
        role="tab"
        aria-selected={stepIndex === commentStepIndex}
        onClick={() => onSelectStep(commentStepIndex)}
        className={cn(
          'inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring',
          stepIndex === commentStepIndex
            ? 'border-accent-strong bg-accent-strong/15 text-foreground'
            : hasComment
              ? 'border-border bg-card text-foreground hover:border-accent-strong/50'
              : 'border-dashed border-border bg-transparent text-muted-foreground hover:text-foreground',
        )}
      >
        <MessageSquareTextIcon aria-hidden="true" className="size-3" />
        <span>Comment</span>
      </button>
    </div>
  )
}

export function AskCommentStep({
  questions,
  selections,
  otherAnswers,
  comment,
  disabled,
  onCommentChange,
  onJumpToQuestion,
}: {
  questions: readonly UiAskQuestion[]
  selections: Readonly<Record<number, string[]>>
  otherAnswers: Readonly<Record<number, string>>
  comment: string
  disabled: boolean
  onCommentChange: (value: string) => void
  onJumpToQuestion: (index: number) => void
}) {
  const commentId = useId()
  return (
    <div data-slot="ask-comment-step" className="flex flex-col gap-2.5">
      <div className="rounded-lg border border-border bg-card p-2.5">
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Selected answers
        </p>
        <ul className="flex flex-col gap-1">
          {questions.map((question, index) => {
            const answered = questionAnswered(index, selections, otherAnswers)
            return (
              <li key={question.id ?? index} className="flex items-baseline justify-between gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => onJumpToQuestion(index)}
                  className="min-h-11 text-start font-medium text-link-foreground underline-offset-4 hover:underline md:min-h-6"
                >
                  {question.header}
                </button>
                <span className={cn('min-w-0 truncate text-end', answered ? 'text-foreground' : 'text-danger')}>
                  {questionSummaryText(index, selections, otherAnswers)}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
      <div>
        <label htmlFor={commentId} className="mb-1 block text-xs font-medium text-foreground">
          Additional comments (optional)
        </label>
        <Textarea
          id={commentId}
          data-slot="ask-additional-comment"
          rows={2}
          value={comment}
          disabled={disabled}
          placeholder="Optional extra notes to send with your selections…"
          onChange={(event) => onCommentChange(event.target.value)}
          className="bg-card text-base md:text-[13px]"
        />
      </div>
    </div>
  )
}

export function AskFreeTextBody({
  value,
  onValueChange,
  disabled,
  renderFreeTextReply,
}: {
  value: string
  onValueChange: (next: string) => void
  disabled: boolean
  renderFreeTextReply: ((props: FreeTextReplyRenderProps) => ReactNode) | undefined
}) {
  const inputId = useId()
  if (renderFreeTextReply) {
    return (
      <div data-slot="ask-free-text">
        {renderFreeTextReply({ value, onValueChange, disabled })}
      </div>
    )
  }
  return (
    <div data-slot="ask-free-text" className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-xs font-medium text-foreground">
        Reply to the agent
      </label>
      <Textarea
        id={inputId}
        rows={2}
        value={value}
        disabled={disabled}
        placeholder="Write a free-text reply…"
        onChange={(event) => onValueChange(event.target.value)}
        className="bg-card text-base md:text-[13px]"
      />
    </div>
  )
}

export function SteppedFooterControls({
  stepIndex,
  questionCount,
  answeredCount,
  allAnswered,
  hasComment,
  resuming,
  disabled,
  onBack,
  onNext,
  onOpenComment,
  onSend,
  questions,
  selections,
  otherAnswers,
  stopControl,
}: {
  stepIndex: number
  questionCount: number
  answeredCount: number
  allAnswered: boolean
  hasComment: boolean
  resuming: boolean
  disabled: boolean
  onBack: () => void
  onNext: () => void
  onOpenComment: () => void
  onSend: () => void
  questions: readonly UiAskQuestion[]
  selections: Readonly<Record<number, string[]>>
  otherAnswers: Readonly<Record<number, string>>
  stopControl?: ReactNode | undefined
}) {
  const onLastQuestion = stepIndex === questionCount - 1
  const onCommentStep = stepIndex === questionCount
  const sendLabel = resuming ? 'Send answer & reopen' : 'Send answer'

  return (
    <div className="flex flex-wrap items-center gap-2">
      {stepIndex > 0 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 min-w-11 px-3 md:min-h-8 md:min-w-0"
          onClick={onBack}
        >
          <ChevronLeftIcon aria-hidden="true" className="size-4" />
          Back
        </Button>
      ) : null}

      {/* Decorative progress dots (non-button spans so mobile touch-target sweeps never flag them). */}
      <span
        data-slot="ask-progress-dots"
        aria-hidden="true"
        className="flex items-center gap-1.5 px-1 md:hidden"
      >
        {questions.map((question, index) => {
          const active = index === stepIndex
          const answered = questionAnswered(index, selections, otherAnswers)
          return (
            <span
              key={question.id ?? index}
              className={cn(
                'size-2 rounded-full motion-safe:transition-colors',
                active
                  ? 'bg-accent-strong'
                  : answered
                    ? 'bg-success'
                    : 'bg-border',
              )}
            />
          )
        })}
        <span
          className={cn(
            'size-2 rounded-full motion-safe:transition-colors',
            onCommentStep ? 'bg-accent-strong' : hasComment ? 'bg-success' : 'bg-border/60',
          )}
        />
      </span>

      <span data-slot="ask-progress-summary" className="hidden text-xs text-soft-foreground tabular-nums sm:inline">
        {answeredCount} of {questionCount} answered
      </span>

      {resuming ? (
        <span data-slot="ask-resume-hint" className="text-xs text-soft-foreground">
          Reopens the closed session.
        </span>
      ) : null}

      <div className="ms-auto flex flex-wrap items-center gap-2">
        {stopControl}
        {!onLastQuestion && !onCommentStep ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 min-w-11 px-3 md:min-h-8 md:min-w-0"
            onClick={onNext}
          >
            Next
            <ChevronRightIcon aria-hidden="true" className="size-4" />
          </Button>
        ) : null}
        {onLastQuestion ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 min-w-11 px-3 md:min-h-8 md:min-w-0"
            onClick={onOpenComment}
          >
            {hasComment ? 'Edit comment' : '+ Comment'}
          </Button>
        ) : null}
        {onLastQuestion || onCommentStep || allAnswered ? (
          <Button
            type="button"
            size="sm"
            className="min-h-11 min-w-11 px-3.5 md:min-h-8 md:min-w-0"
            disabled={disabled || !allAnswered}
            onClick={onSend}
          >
            {sendLabel}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function SingleAskFooterControls({
  oneTap,
  hasOtherAnswer,
  allowComment,
  commentOpen,
  hasComment,
  resuming,
  disabled,
  onToggleComment,
  onSend,
  stopControl,
}: {
  oneTap: boolean
  hasOtherAnswer: boolean
  allowComment: boolean
  commentOpen: boolean
  hasComment: boolean
  resuming: boolean
  disabled: boolean
  onToggleComment: () => void
  onSend: () => void
  stopControl?: ReactNode | undefined
}) {
  const sendLabel = resuming ? 'Send answer & reopen' : 'Send answer'
  const showSend = !oneTap || hasOtherAnswer || commentOpen || hasComment

  return (
    <div className="flex flex-wrap items-center gap-2">
      {allowComment ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11 min-w-11 px-2 text-xs text-muted-foreground hover:text-foreground md:min-h-8 md:min-w-0"
          onClick={onToggleComment}
        >
          <MessageSquareTextIcon aria-hidden="true" className="size-3.5" />
          {commentOpen ? 'Hide comment' : hasComment ? 'Edit comment' : '+ Add comment'}
        </Button>
      ) : null}

      <span
        data-slot={resuming ? 'ask-resume-hint' : 'ask-hint'}
        className="text-xs text-soft-foreground"
      >
        {resuming
          ? 'Reopens the closed session.'
          : oneTap
            ? 'Tap an option to send.'
            : 'Choose an answer, then send.'}
      </span>

      <div className="ms-auto flex items-center gap-2">
        {stopControl}
        {showSend ? (
          <Button
            type="button"
            size="sm"
            className="min-h-11 min-w-11 px-3.5 md:min-h-8 md:min-w-0"
            disabled={disabled}
            onClick={onSend}
          >
            {sendLabel}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function AskDeliveryNotices({
  blockedBy,
  reason,
  error,
}: {
  blockedBy: 'provider' | 'no-session' | undefined
  reason: string | undefined
  error: string | undefined
}) {
  return (
    <>
      {reason ? (
        <p data-slot="ask-blocked-reason" className="text-xs text-muted-foreground">
          {reason}{' '}
          {blockedBy === 'provider' ? (
            <Link
              to="/settings/agent-defaults#providers"
              className="font-medium text-foreground underline underline-offset-4"
            >
              Configure providers
            </Link>
          ) : null}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </>
  )
}

export function ShowOriginLink({
  onShowOrigin,
  className,
}: {
  onShowOrigin: () => void
  className?: string | undefined
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-slot="ask-show-origin"
      onClick={onShowOrigin}
      className={cn(
        'min-h-11 min-w-11 px-2 text-xs font-medium text-link-foreground underline underline-offset-4 md:min-h-8 md:min-w-0',
        className,
      )}
    >
      Show where it was asked
    </Button>
  )
}

/**
 * Non-destructive context sheet (hearsay-tools/squawk#4374): opens directly from `ask.context`
 * on the pending ask payload so selections and drafts stay intact even when the thread has
 * moved hundreds of messages past the origin turn.
 */
export function AskContextSheet({
  open,
  onOpenChange,
  context,
  onShowOrigin,
  returnFocusRef,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  context: string
  onShowOrigin: (() => void) | undefined
  returnFocusRef?: RefObject<HTMLButtonElement | null> | undefined
}) {
  const closingToOriginRef = useRef(false)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        data-slot="ask-context-sheet"
        className="flex w-full max-w-[540px] flex-col gap-0 p-0 sm:max-w-[540px]"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (closingToOriginRef.current) {
            closingToOriginRef.current = false
            return
          }
          returnFocusRef?.current?.focus()
        }}
      >
        <SheetHeader className="relative shrink-0 border-b border-border px-5 py-4 pr-14">
          <SheetTitle>Question context</SheetTitle>
          <SheetDescription>
            Your selections and drafts stay intact while you read.
          </SheetDescription>
          <SheetClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              className="absolute inset-bs-2 end-2 size-11 md:size-9"
            >
              <XIcon aria-hidden="true" className="size-4" />
            </Button>
          </SheetClose>
        </SheetHeader>
        <div
          data-slot="ask-context"
          role="region"
          aria-label="Context"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain break-words px-5 py-4 text-sm text-foreground"
        >
          <Markdown breaks>{context}</Markdown>
        </div>
        {onShowOrigin ? (
          <div className="flex shrink-0 items-center justify-end border-t border-border px-5 py-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-slot="ask-show-origin"
              className="min-h-11 md:min-h-8"
              onClick={() => {
                closingToOriginRef.current = true
                onOpenChange(false)
                onShowOrigin()
              }}
            >
              Show where it was asked
            </Button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
