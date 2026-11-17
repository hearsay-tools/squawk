import type { ReactNode } from 'react'
import type { RunnerSkill, RunnerSkillScope } from '@open-mercato/cezar-api-client/contract/runner-skills'
import { CopyIcon } from '@/components/design-icons'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/components/ui/toaster'

// `other` tells the reader nothing, so the source line leaves it out.
const SCOPE_LABELS: Record<RunnerSkillScope, string | null> = { repo: 'Project', user: 'User', system: 'Built in', other: null }

/** The source line: the runner's scope, then the plugin that ships the skill. */
export function skillSourceLabel(skill: Pick<RunnerSkill, 'scope' | 'plugin'>): string | null {
  const parts = [skill.scope ? SCOPE_LABELS[skill.scope] : null, skill.plugin ? `Plugin ${skill.plugin}` : null]
  return parts.filter(Boolean).join(' · ') || null
}

/** Show only the metadata returned by the selected runner. `heading={null}` leaves the name to
 *  the row that opened the detail. */
export function SkillDetailBody({ skill, heading: Heading = 'h2', actions }: {
  skill: RunnerSkill
  heading?: 'h2' | 'h3' | null
  actions?: ReactNode
}) {
  const source = skillSourceLabel(skill)
  return (
    <div data-slot="skill-detail" className="grid min-w-0 gap-3 break-words">
      {Heading ? <Heading className="text-xl font-semibold">{skill.name}</Heading> : null}
      {skill.description
        ? <p data-slot="skill-description" className="max-w-[78ch] text-[13.5px] leading-relaxed">{skill.description}</p>
        : <p className="text-xs text-soft-foreground">This runner reports no description.</p>}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 text-[12.5px]">
        <DetailField label="Id"><CopyValue value={skill.id} label="Copy id" /></DetailField>
        {source ? <DetailField label="Source"><span data-slot="skill-source">{source}</span></DetailField> : null}
        {skill.path ? <DetailField label="File"><CopyValue value={skill.path} label="Copy path" slot="skill-path" /></DetailField> : null}
      </dl>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return <><dt className="text-soft-foreground">{label}</dt><dd className="flex min-w-0 items-center gap-1">{children}</dd></>
}

function CopyValue({ value, label, slot }: { value: string; label: string; slot?: string }) {
  const copy = () => navigator.clipboard.writeText(value).then(
    () => toast('Copied.'),
    (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }),
  )
  return (
    <>
      <code data-slot={slot} title={value} className="min-w-0 truncate rounded-sm border border-border bg-background px-1.5 py-px font-mono text-xs">{value}</code>
      <button type="button" aria-label={label} onClick={() => void copy()}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-soft-foreground focus-visible:outline-2 pointer-hover:bg-muted pointer-hover:text-foreground">
        <CopyIcon aria-hidden="true" className="size-3.5" />
      </button>
    </>
  )
}

export function SkillPreviewDialog({ skill, onClose }: { skill: RunnerSkill | null; onClose: () => void }) {
  return (
    <Dialog open={skill !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent data-slot="skill-preview" className="max-h-[80dvh] overflow-y-auto">
        {skill ? <>
          <DialogTitle className="sr-only">{skill.name}</DialogTitle>
          <DialogDescription className="sr-only">Runner skill metadata</DialogDescription>
          <SkillDetailBody skill={skill} heading="h3" />
        </> : null}
      </DialogContent>
    </Dialog>
  )
}
