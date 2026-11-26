import { useState, type ReactNode } from 'react'
import { useHealth, useProjects } from '@/api/queries'
import { AddProjectDialog } from '@/components/add-project-dialog'
import { CloneProjectDialog } from '@/components/clone-project-dialog'
import { CreateProjectDialog } from '@/components/create-project-dialog'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { Link as RouterLink } from 'react-router'
import { TOOL_LINK_CLASS, TOOL_SETTINGS_PATH, toolHint, toolSetupPath, toolStateLabel, toolTone } from '@/lib/tool-status'
import { githubRepoBase } from '@/lib/tasks-table'

type HealthQuery = ReturnType<typeof useHealth>
type ProjectsQuery = ReturnType<typeof useProjects>
type ProjectAction = 'new' | 'local' | 'clone'

/** Render diagnostic hints with proper sentence capitalization for "Install" and inline `<code>`
 *  chips for backticked CLI commands (e.g. `gh auth login`) instead of literal backticks. */
function renderToolHint(raw: string): ReactNode {
  const normalized = raw.replace(/\binstall\b/g, (match, offset: number) => (offset === 0 ? 'Install' : match))
  const parts = normalized.split(/(`[^`]+`)/g)
  if (parts.length === 1) {
    // Also highlight an unbackticked `gh auth login` CLI command as a code chip.
    const cliParts = normalized.split(/(\bgh auth login\b)/g)
    if (cliParts.length === 1) return normalized
    return cliParts.map((part, index) =>
      part === 'gh auth login' ? (
        <code key={index} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px] text-foreground">{part}</code>
      ) : (
        <span key={index}>{part}</span>
      ),
    )
  }
  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={index} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px] text-foreground">
          {part.slice(1, -1)}
        </code>
      )
    }
    return part ? <span key={index}>{part}</span> : null
  })
}

/** The Add project launchers: what exists (local folder, repository, checkout folder) and the
 *  three ways to add one. */
function AddProjectSection({ health, projects, repository, onAction }: {
  health: HealthQuery
  projects: ProjectsQuery
  repository: string | undefined
  onAction: (action: ProjectAction) => void
}) {
  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-6 max-md:p-4" aria-labelledby="add-project-heading">
      <div>
        <h2 id="add-project-heading" className="text-base font-semibold text-foreground">Add project</h2>
        <p className="mt-1 text-[13px] leading-[1.5] text-muted-foreground">Start a new repository, open an existing local folder, or clone a GitHub repository.</p>
      </div>
      <dl className="space-y-2.5 text-[13px] leading-[1.5] text-muted-foreground">
        {health.data?.repoRoot ? <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-[160px_minmax(0,1fr)]"><dt className="font-medium text-foreground">Local folder</dt><dd className="min-w-0 font-mono text-xs break-all">{health.data.repo?.root ?? health.data.repoRoot}</dd></div> : null}
        {repository ? <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-[160px_minmax(0,1fr)]"><dt className="font-medium text-foreground">Repository</dt><dd className="min-w-0 font-mono text-xs break-all">{repository.replace(/^https:\/\//, '')}</dd></div> : null}
        {projects.data?.projectsDir ? <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-[160px_minmax(0,1fr)]"><dt className="font-medium text-foreground">Checkout folder</dt><dd className="min-w-0 font-mono text-xs break-all">{projects.data.projectsDir}</dd></div> : null}
      </dl>
      <div className="flex flex-wrap gap-2.5">
        <Button variant="outline" className="h-10 rounded-lg px-3.5 text-xs font-medium max-md:h-11" data-action="new-project" onClick={() => onAction('new')}>New project</Button>
        <Button variant="outline" className="h-10 rounded-lg px-3.5 text-xs font-medium max-md:h-11" onClick={() => onAction('local')}>Open local folder</Button>
        <Button variant="outline" className="h-10 rounded-lg px-3.5 text-xs font-medium max-md:h-11" onClick={() => onAction('clone')}>Clone from GitHub</Button>
      </div>
    </section>
  )
}

/** The tools diagnostics panel: one row per check in an aligned fixed-tool-column grid, plus recheck and copy. */
function ToolsDiagnosticsSection({ health, copying, onCopy }: {
  health: HealthQuery
  copying: boolean
  onCopy: () => Promise<void>
}) {
  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-6 max-md:p-4" aria-labelledby="tools-heading">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="tools-heading" className="text-base font-semibold text-foreground">Tools diagnostics</h2>
          <p className="mt-1 text-[13px] leading-[1.5] text-muted-foreground">Check the tools available to this local workspace.</p>
        </div>
        <RouterLink to={TOOL_SETTINGS_PATH} data-slot="tools-settings" className={TOOL_LINK_CLASS}>Tool settings ›</RouterLink>
      </div>
      {health.isError ? <p role="alert" className="text-sm text-destructive">Could not refresh tool diagnostics. Recheck to retry.</p> : null}
      {!health.data && !health.isError ? <p role="status" className="text-sm text-muted-foreground">Checking installed tools…</p> : null}
      {health.data ? <dl className="divide-y divide-border border-y border-border text-[13px] leading-[1.5] text-muted-foreground">
        {health.data.checks.map((check) => {
          const hint = toolHint(check)
          return <div key={check.name} data-slot="tool-row" data-tool={check.name} data-available={check.available} className="grid grid-cols-1 gap-x-4 gap-y-1 py-3 sm:grid-cols-[160px_minmax(0,1fr)] sm:items-center">
            <dt className="flex items-center gap-2.5">
              <StatusDot tone={toolTone(check)} />
              <span className="font-mono text-[13px] font-medium text-foreground">{check.name}</span>
            </dt>
            <dd className="flex min-w-0 items-center gap-x-3 text-muted-foreground">
              <span className="min-w-0 break-words">{toolStateLabel(check)}{check.version ? ` · ${check.version}` : ''}</span>
              {check.available ? null : <RouterLink to={toolSetupPath(check.name)} data-slot="tool-setup" className={`${TOOL_LINK_CLASS} ml-auto shrink-0`}>Set up ›</RouterLink>}
            </dd>
            {hint ? <dd data-slot="tool-hint" className="min-w-0 break-words text-xs leading-relaxed text-muted-foreground sm:col-start-2">{renderToolHint(hint)}</dd> : null}
          </div>
        })}
      </dl> : null}
      {health.data?.checks.length === 0 ? <p className="text-sm text-muted-foreground">No tool diagnostics reported by this server.</p> : null}
      <div className="flex flex-wrap gap-2.5">
        <Button variant="outline" className="h-10 rounded-lg px-3.5 text-xs font-medium max-md:h-11" disabled={health.isFetching} onClick={() => void health.refetch()}>{health.isFetching ? 'Checking tools…' : 'Recheck tools'}</Button>
        <Button variant="outline" className="h-10 rounded-lg px-3.5 text-xs font-medium max-md:h-11" disabled={!health.data || copying} onClick={() => void onCopy()}>{copying ? 'Copying…' : 'Copy diagnostics'}</Button>
      </div>
    </section>
  )
}

/** Shared navigation frame 24: existing project launchers and live tool diagnostics. */
export function WorkspaceToolsRoute() {
  const health = useHealth()
  const projects = useProjects()
  const repository = githubRepoBase(health.data?.repo?.remote)
  const [projectAction, setProjectAction] = useState<'new' | 'local' | 'clone' | null>(null)
  const [copying, setCopying] = useState(false)
  const copyDiagnostics = async () => {
    if (!health.data || copying) return
    setCopying(true)
    try {
      await navigator.clipboard.writeText(JSON.stringify({ version: health.data.version, checks: health.data.checks }, null, 2))
      toast('Diagnostics copied')
    } catch {
      toast('Could not copy diagnostics. Please try again.', { tone: 'danger' })
    } finally {
      setCopying(false)
    }
  }

  return (
    <div data-route="workspace-tools" className="w-full space-y-5 px-4 pt-7 pb-9 md:px-9">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[26px] font-semibold tracking-tight leading-[1.2] text-foreground md:text-[28px]">Workspace tools</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Add projects and inspect local workspace CLI diagnostics.</p>
        </div>
      </header>
      <AddProjectSection health={health} projects={projects} repository={repository} onAction={setProjectAction} />
      <ToolsDiagnosticsSection health={health} copying={copying} onCopy={copyDiagnostics} />
      {projectAction === 'new' ? <CreateProjectDialog open onOpenChange={(open) => { if (!open) setProjectAction(null) }} /> : null}
      {projectAction === 'local' ? <AddProjectDialog open onOpenChange={(open) => { if (!open) setProjectAction(null) }} /> : null}
      {projectAction === 'clone' ? <CloneProjectDialog open onOpenChange={(open) => { if (!open) setProjectAction(null) }} /> : null}
    </div>
  )
}
