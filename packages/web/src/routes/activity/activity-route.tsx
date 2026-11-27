import * as React from 'react'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'

import { useActivityLive } from '@/api/activity-live'
import { BoardPage, PageShellSparseFooter, pageShellDensity } from '@/components/page-shell'
import { Button } from '@/components/ui/button'
import { useActiveProjectId } from '@/lib/project-router'

import { ActivityBoard } from './activity-board'
import { ActivityQuickLinks, ScopeSwitch, SummaryChips, activityHeaderProps } from './activity-header'
import { ActivityLoading } from './activity-loading'
import { projectNotice, summarize } from './activity-model'
import { useActivityMotion } from './use-activity-motion'
import { useServerNow } from './use-server-now'
import './activity-motion.css'

/**
 * `/p/:projectId/activity` (spec 2026-11-05-live-activity-view, "Project view"): the live
 * snapshot (`useActivityLive`: the topic, or the 5 s re-read without topics) and its motion.
 */

export function ProjectActivityRoute() {
  const scopeId = queryScope()
  const activity = useActivityLive({ kind: 'project', projectId: scopeId })
  const projectId = useActiveProjectId()
  const [watchingSince] = React.useState(() => new Date().toISOString())
  const now = useServerNow(activity.data?.generatedAt, activity.dataUpdatedAt)
  const { motion, feed, reduced, paused } = useActivityMotion(activity.data, scopeId)
  const project = activity.data?.projects[0]

  if (activity.isPending) return <ActivityLoading />
  const notice = project ? projectNotice(project) : undefined
  if (!project) {
    return (
      <BoardPage
        route="activity"
        density="empty"
        header={activityHeaderProps({
          name: projectId ?? 'project',
          scopeSwitch: <ScopeSwitch scope="project" projectId={projectId} />,
        })}
      >
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-5 text-[13px] text-muted-foreground">
          {activity.error ? `Could not load activity: ${activity.error.message}` : 'This project has no activity snapshot.'}
          <Button size="sm" variant="outline" onClick={() => void activity.refetch()} className="max-md:min-h-11">Retry</Button>
        </div>
      </BoardPage>
    )
  }
  const density = pageShellDensity(project.tasks.length)
  return (
    <BoardPage
      route="activity"
      density={density}
      headerSpacing="compact"
      rootProps={{ 'data-activity-paused': paused ? 'true' : undefined }}
      bodyClassName="gap-3.5"
      header={activityHeaderProps({
        name: project.name,
        now,
        updatedAt: activity.data?.generatedAt,
        stale: activity.isError,
        scopeSwitch: <ScopeSwitch scope="project" projectId={projectId ?? project.projectId} projectName={project.name} />,
      })}
      sparseFooter={
        !notice && project.tasks.length > 0 ? (
          <PageShellSparseFooter
            summary={`${project.tasks.length} active ${project.tasks.length === 1 ? 'task' : 'tasks'} running in ${project.name}. Start more work in parallel or inspect all tasks.`}
            actions={<ActivityQuickLinks />}
          />
        ) : undefined
      }
    >
      <SummaryChips summary={summarize([project])} tasksTo="/" bumps={motion.bumps} />
      {notice ? (
        <p data-slot="activity-project-notice" role="status" className="rounded-xl border border-border bg-card p-5 text-[13px] text-muted-foreground">{notice}</p>
      ) : (
        <ActivityBoard project={project} now={now} watchingSince={watchingSince} motion={motion} feed={feed} still={reduced} paused={paused} />
      )}
    </BoardPage>
  )
}
