import { useState } from 'react'
import type { RunnerSkill } from '@open-mercato/cezar-api-client/contract/runner-skills'
import { ChevronRightIcon, FolderIcon, UserRoundIcon, FoldersIcon } from '@/components/design-icons'
import { SkillDetailBody } from '@/components/skill-detail'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'
import { skillKey } from '@/lib/skills'
import { cn } from '@/lib/utils'
import { newTaskPrefillHref } from './new-task-params'
import type { Runner } from '@open-mercato/cezar-api-client'

type GroupKind = 'project' | 'user' | 'plugin' | 'system' | 'other'
export interface SkillGroup { key: string; label: string; kind: GroupKind; skills: RunnerSkill[] }

/** A plugin id can carry its marketplace (`name@market`); the group shows the name. */
const pluginName = (plugin: string) => plugin.split('@')[0] || plugin

const GROUP_ORDER: Record<GroupKind, number> = { project: 0, user: 1, plugin: 2, system: 3, other: 4 }
const FIXED_GROUPS: Record<Exclude<GroupKind, 'plugin'>, string> = {
  project: 'This project', user: 'Your skills', system: 'Built in', other: 'Other',
}

function groupOf(skill: RunnerSkill): Pick<SkillGroup, 'key' | 'label' | 'kind'> {
  if (skill.plugin) return { key: `plugin:${skill.plugin}`, label: pluginName(skill.plugin), kind: 'plugin' }
  const kind: GroupKind = skill.scope === 'repo' ? 'project' : skill.scope === 'user' ? 'user' : skill.scope === 'system' ? 'system' : 'other'
  return { key: kind, label: FIXED_GROUPS[kind], kind }
}

/** Group by plugin, else by scope: project, your skills, plugins by name, built in, other.
 *  Skills keep their incoming order inside a group, so a search keeps its ranking. */
export function groupRunnerSkills(skills: readonly RunnerSkill[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>()
  for (const skill of skills) {
    const group = groupOf(skill)
    const entry = groups.get(group.key) ?? { ...group, skills: [] }
    entry.skills.push(skill)
    groups.set(group.key, entry)
  }
  return [...groups.values()].sort((a, b) => GROUP_ORDER[a.kind] - GROUP_ORDER[b.kind] || a.label.localeCompare(b.label))
}

/** The plugin header already names the plugin, so the row drops its `plugin:` prefix. */
export function shortSkillName(skill: RunnerSkill): string {
  const prefix = skill.plugin ? `${pluginName(skill.plugin)}:` : ''
  return prefix && skill.name.startsWith(prefix) && skill.name.length > prefix.length ? skill.name.slice(prefix.length) : skill.name
}

const GROUP_ICONS = { project: FolderIcon, user: UserRoundIcon, plugin: FoldersIcon, system: FoldersIcon, other: FoldersIcon }

export function SkillGroups({ groups, openId, searching, runner, account }: {
  groups: readonly SkillGroup[]
  openId: string | null
  searching: boolean
  runner: Runner
  account: string | null
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const toggle = (key: string) => setFolded((current) => {
    const next = new Set(current)
    if (!next.delete(key)) next.add(key)
    return next
  })
  return (
    <div data-slot="skills-list" className="overflow-hidden rounded-xl border border-border bg-card">
      {groups.map((group) => {
        // Groups start open, so a `?skill=` link finds its row; a search shows every match.
        const open = searching || !folded.has(group.key)
        return (
          <section key={group.key} data-slot="skill-group" aria-label={group.label} className="border-border not-first:border-t">
            <GroupHeader group={group} open={open} onToggle={() => toggle(group.key)} />
            {open ? group.skills.map((skill) => (
              <SkillRow key={skillKey(skill)} skill={skill} open={skill.id === openId} runner={runner} account={account} />
            )) : null}
          </section>
        )
      })}
    </div>
  )
}

function GroupHeader({ group, open, onToggle }: { group: SkillGroup; open: boolean; onToggle: () => void }) {
  const Icon = GROUP_ICONS[group.kind]
  return (
    <h2 className="m-0">
      <button type="button" aria-expanded={open} onClick={onToggle}
        className="flex min-h-10 w-full items-center gap-2 bg-muted/45 px-3.5 text-left text-xs font-semibold text-muted-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 pointer-hover:text-foreground">
        <ChevronRightIcon aria-hidden="true" className={cn('size-3.5 transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
        <Icon aria-hidden="true" className="size-3.5" />
        <span className="min-w-0 truncate">{group.label}</span>
        <span className="font-medium text-soft-foreground">{group.skills.length}</span>
      </button>
    </h2>
  )
}

function SkillRow({ skill, open, runner, account }: { skill: RunnerSkill; open: boolean; runner: Runner; account: string | null }) {
  const start = newTaskPrefillHref({ skill: skill.id, skillPath: skill.path, runner, ...(account ? { account } : {}) })
  return (
    <details data-slot="skill-row" data-skill={skill.id} data-skill-path={skill.path} name="skill-details" open={open || undefined}
      className="group/skill border-t border-border/60 open:bg-sidebar-row-selected">
      <summary className="grid min-h-11 cursor-pointer list-none grid-cols-1 items-start gap-x-4 gap-y-1 py-2.5 pr-4 pl-9 focus-visible:outline-2 focus-visible:-outline-offset-2 pointer-hover:bg-sidebar-row-hover sm:grid-cols-[minmax(10rem,15rem)_minmax(0,1fr)] [&::-webkit-details-marker]:hidden">
        <span className="truncate pt-0.5 text-[13.5px] font-semibold text-foreground" title={skill.name}>{shortSkillName(skill)}</span>
        {skill.description
          ? <span className="min-w-0 line-clamp-2 text-[13px] leading-[1.45] text-muted-foreground [overflow-wrap:anywhere] group-open/skill:hidden">{skill.description}</span>
          : null}
      </summary>
      <div className="pr-3.5 pb-4 pl-9">
        <SkillDetailBody skill={skill} heading={null} actions={
          <Button asChild size="sm" data-action="start-task">
            <Link to={start}>Start task</Link>
          </Button>
        } />
      </div>
    </details>
  )
}
