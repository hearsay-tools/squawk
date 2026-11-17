import type { RunnerSkill } from '@open-mercato/cezar-api-client/contract/runner-skills'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

/** Show only the metadata returned by the selected runner. */
export function SkillDetailBody({ skill, heading: Heading = 'h2' }: {
  skill: RunnerSkill
  heading?: 'h2' | 'h3'
}) {
  return (
    <div data-slot="skill-detail" className="grid min-w-0 gap-3 break-words">
      <Heading className="text-xl font-semibold">{skill.name}</Heading>
      <p className="font-mono text-sm">{skill.id}</p>
      {skill.description ? <p data-slot="skill-description">{skill.description}</p> : null}
      {skill.scope ? <p data-slot="skill-source">Scope: {skill.scope}</p> : null}
      {skill.plugin ? <p>Plugin: {skill.plugin}</p> : null}
      {skill.path ? <p data-slot="skill-path" className="break-all font-mono text-sm">{skill.path}</p> : null}
    </div>
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
