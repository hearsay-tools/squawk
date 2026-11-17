import type { RunnerSkill } from '@open-mercato/cezar-api-client/contract/runner-skills'
import { cn } from '@/lib/utils'

/** Keep a runner's display name, description and optional disambiguating path together. */
export function SkillOptionLabel({ skill, emphasized }: { skill: RunnerSkill; emphasized: boolean }) {
  return <>
    <span className={cn('shrink-0 font-mono text-xs', emphasized && 'font-semibold')}>{skill.name}</span>
    {skill.description ? <span title={skill.description} className="min-w-0 flex-1 truncate text-xs text-soft-foreground">{skill.description}</span> : null}
    {skill.path ? <span title={skill.path} className="min-w-0 truncate text-xs text-soft-foreground">{skill.path}</span> : null}
  </>
}
