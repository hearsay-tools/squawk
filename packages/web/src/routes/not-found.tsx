import { CompassIcon } from 'lucide-react'
import { PageShellActionButton, PageShellEmptyState, ReadingPage } from '@/components/page-shell'
import { Link } from '@/lib/project-router'

/** The 404. Neutral, not danger — a mistyped URL is a dead end, not a failure of ours —
 *  and the one action is the way home (spec, "Routing": unknown routes → 404
 *  with a "Back to tasks" action). */
export function NotFoundRoute() {
  return (
    <ReadingPage
      route="not-found"
      density="empty"
      header={{
        title: 'Page not found',
        subtitle: 'Nothing lives at this address.',
        primaryAction: (
          <PageShellActionButton asChild variant="outline">
            <Link to="/">Back to tasks</Link>
          </PageShellActionButton>
        ),
      }}
      emptyState={
        <PageShellEmptyState
          icon={<CompassIcon className="size-4" />}
          title="Address not found"
          description="The link may be mistyped, or it points at something that is gone."
        />
      }
    />
  )
}
