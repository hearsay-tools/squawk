import { PlayIcon } from 'lucide-react'

import type { GithubItem } from '@open-mercato/cezar-api-client'
import { CheckIcon } from '@/components/design-icons'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'

/** The pane's above-the-fold action: the hand-off below, one click away — or the task it
 *  already queued. It jumps to the prompt rather than starting a run, so the workflow, skills and
 *  runner below stay the reader's choice. */
export function HandoffHeaderAction({ item, queuedRunId }: { item: GithubItem; queuedRunId: string | null }) {
  if (queuedRunId) {
    return (
      <Button asChild variant="outline" size="sm" className="max-md:h-11 no-hover:h-11">
        <Link to={`/tasks/${queuedRunId}`} data-action="gh-header-view-task">
          <CheckIcon size={16} aria-hidden="true" className="size-3.5 text-success" />
          Open queued task
        </Link>
      </Button>
    )
  }
  return (
    <Button
      type="button"
      variant="primary"
      size="sm"
      data-action="gh-header-handoff"
      title={`Write the prompt and pick the workflow and runner for this ${item.kind === 'pr' ? 'PR' : 'issue'}`}
      className="max-md:h-11 no-hover:h-11"
      onClick={focusHandToAgentPrompt}
    >
      <PlayIcon aria-hidden="true" className="size-3.5" />
      Hand to agent
    </Button>
  )
}

/** The merge box's conflict action: bring the hand-to-agent prompt below it into view. */
export function focusHandToAgentPrompt() {
  const prompt = document.querySelector<HTMLTextAreaElement>('[data-slot="gh-detail-inner"] [data-slot="gh-custom-prompt"]')
  prompt?.scrollIntoView({ block: 'center' })
  prompt?.focus({ preventScroll: true })
}
