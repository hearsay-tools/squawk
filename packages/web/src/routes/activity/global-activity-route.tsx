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

import { ScopeSwitch, SummaryChips, activityHeaderProps } from './activity-header'
import { summarize } from './activity-model'
import { groupProjects, inRailOrder } from './global-model'
import { IdleLine, ProjectPanel } from './global-panel'
import { useActivityMotion } from './use-activity-motion'
import { useServerNow } from './use-server-now'
import './activity-motion.css'

/**
 * `/activity`, the global activity view (spec 2026-11-05-live-activity-view, "Global view"),
 * static: one panel for each project with active work or with a notice, in project-rail order,
 * and the loaded idle projects in one line at the bottom. It reads the live workspace snapshot
 * (`useActivityLive`) and plays the same motion on the pills and arcs as the project view.
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
  const now = useServerNow(activity.data?.generatedAt, activity.dataUpdatedAt)
  const snapshot = activity.data?.projects
  const groups = React.useMemo(() => groupProjects(inRailOrder(snapshot ?? [], railIds)), [snapshot, railIds])
  const { motion, paused, reduced } = useActivityMotion(activity.data, 'workspace')

  const density = snapshot ? pageShellDensity(groups.panels.length) : 'full'

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
        scopeSwitch: <ScopeSwitch scope="all" projectId={back.id} projectName={back.name} />,
      })}
      sparseFooter={
        snapshot && groups.panels.length > 0 ? (
          <PageShellSparseFooter
            summary={`${groups.panels.length} active ${groups.panels.length === 1 ? 'project' : 'projects'} with live work.`}
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
      <div data-slot="activity-panels" className="flex flex-col gap-3">
        {groups.panels.map((project) => <ProjectPanel key={project.projectId} project={project} now={now} motion={motion} paused={paused || reduced} />)}
      </div>
      <IdleLine projects={groups.idle} belowPanels={groups.panels.length > 0} />
    </BoardPage>
  )
}
