import * as React from 'react'
import { Link as RouterLink, useLocation } from 'react-router'

import { useActivityLive } from '@/api/activity-live'
import { useHealth, useProjects } from '@/api/queries'
import {
  BoardPage,
  PageShellEmptyState,
  PageShellSparseFooter,
  pageShellDensity,
} from '@/components/page-shell'
import { Button } from '@/components/ui/button'
import { orderProjects } from '@/lib/project-order'
import { useProjectOrder } from '@/lib/use-project-order'

import {
  ActivityHeaderActions,
  SummaryChips,
  activityHeaderProps,
} from './activity-header'
import { projectNotice, summarize } from './activity-model'
import { ActivitySupervisionView } from './activity-supervision-view'
import { groupProjects, inRailOrder } from './global-model'
import { IdleLine, ProjectPanel } from './global-panel'
import { useActivityMotion } from './use-activity-motion'
import { useServerNow } from './use-server-now'
import './activity-motion.css'

/**
 * `/activity`, the global supervision decision queue (hearsay-tools/squawk#4376):
 * flat priority-sorted Attention queue and compact Working rows across every loaded project
 * (each item carrying its project badge) with an explicit `Group by project` toggle, inline
 * triage drawer, collapsible margin arcs, unloaded/unavailable project notices, and the idle line.
 */

const WORKSPACE = { kind: 'workspace' } as const

/** The project ids in the order the rail shows them, once the registry has answered. */
function useRailIds(): string[] | undefined {
  const registry = useProjects().data?.projects
  const { order } = useProjectOrder()
  return React.useMemo(() => (registry ? orderProjects(registry, order).map((project) => project.id) : undefined), [registry, order])
}

/** The project the scope switch leads back to: the one this history entry came from, else the
 *  boot project. Its name labels the segment. */
function useReturnProject(): { id: string | null; name: string | undefined } {
  const projects = useProjects().data
  const health = useHealth()
  const returnProjectId: unknown = useLocation().state?.activityProjectId
  const boot = projects?.bootProject ?? health.data?.bootProject ?? null
  // Keep the origin per history entry: another tab or a later visit cannot replace it.
  const id = typeof returnProjectId === 'string' && projects?.projects.some((project) => project.id === returnProjectId && project.status !== 'missing') ? returnProjectId : boot
  return { id, name: projects?.projects.find((project) => project.id === id)?.name }
}

export function GlobalActivityRoute() {
  const activity = useActivityLive(WORKSPACE)
  const back = useReturnProject()
  const railIds = useRailIds()
  const [grouped, setGrouped] = React.useState(false)
  const now = useServerNow(activity.data?.generatedAt, activity.dataUpdatedAt)
  const snapshot = activity.data?.projects
  const ordered = React.useMemo(() => inRailOrder(snapshot ?? [], railIds), [snapshot, railIds])
  const groups = React.useMemo(() => groupProjects(ordered), [ordered])
  const activeProjects = React.useMemo(
    () => groups.panels.filter((project) => projectNotice(project) === undefined),
    [groups.panels],
  )
  const noticeProjects = React.useMemo(
    () => groups.panels.filter((project) => projectNotice(project) !== undefined),
    [groups.panels],
  )
  const projectOrder = React.useMemo(() => ordered.map((project) => project.projectId), [ordered])
  const { motion, feed, paused, reduced } = useActivityMotion(activity.data, 'workspace')

  const totalTasks = activeProjects.reduce((sum, project) => sum + project.tasks.length, 0)
  const density = snapshot ? pageShellDensity(totalTasks + noticeProjects.length) : 'full'

  return (
    <BoardPage
      route="activity-global"
      density={density}
      headerSpacing="compact"
      rootProps={{ 'data-activity-paused': paused ? 'true' : undefined }}
      bodyClassName="gap-3.5"
      header={activityHeaderProps({
        name: 'All projects',
        now: activity.data ? now : undefined,
        updatedAt: activity.data?.generatedAt,
        stale: activity.isError,
        scopeSwitch: (
          <ActivityHeaderActions
            scope="all"
            projectId={back.id}
            projectName={back.name}
            grouped={grouped}
            onToggleGroup={() => setGrouped((value) => !value)}
          />
        ),
      })}
      sparseFooter={
        snapshot && groups.panels.length > 0 ? (
          <PageShellSparseFooter
            summary={`${activeProjects.length} active ${activeProjects.length === 1 ? 'project' : 'projects'} with live work.`}
            actions={
              <Button variant="outline" size="sm" asChild className="max-md:min-h-11">
                <RouterLink to="/tasks">View all tasks</RouterLink>
              </Button>
            }
          />
        ) : undefined
      }
    >
      {snapshot ? <SummaryChips summary={summarize(snapshot)} tasksTo="/tasks" bumps={motion.bumps} /> : null}
      {/* The header and the scope switch stay while the snapshot loads: the user can switch away. */}
      {activity.isPending ? <p data-slot="activity-loading" role="status" className="text-xs text-muted-foreground">Loading activity…</p> : null}
      {activity.isError && !snapshot ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-5 text-[13px] text-muted-foreground">
          Could not load activity: {activity.error.message}
          <Button size="sm" variant="outline" onClick={() => void activity.refetch()} className="max-md:min-h-11">Retry</Button>
        </div>
      ) : null}
      {snapshot && groups.panels.length === 0 && groups.idle.length === 0 ? (
        <PageShellEmptyState
          slot="activity-empty"
          title="No projects to show."
          description="Register a project in Workspace tools to monitor live agent work across repositories."
          actions={
            <Button variant="outline" size="sm" asChild className="max-md:min-h-11">
              <RouterLink to="/tools">Open workspace tools</RouterLink>
            </Button>
          }
        />
      ) : null}
      {activeProjects.length > 0 || feed.length > 0 ? (
        <ActivitySupervisionView
          projects={activeProjects}
          now={now}
          global
          grouped={grouped}
          projectOrder={projectOrder}
          motion={motion}
          feed={feed}
          still={reduced}
          paused={paused}
        />
      ) : null}
      {noticeProjects.length > 0 ? (
        <div data-slot="activity-panels" className="flex flex-col gap-3">
          {noticeProjects.map((project) => (
            <ProjectPanel key={project.projectId} project={project} now={now} motion={motion} paused={paused || reduced} />
          ))}
        </div>
      ) : null}
      <IdleLine projects={groups.idle} belowPanels={groups.panels.length > 0} />
    </BoardPage>
  )
}
