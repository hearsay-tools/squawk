import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { getRunnerSkills } from '@/api/client'
import { useAgentAccounts } from '@/api/agent-accounts'
import { queryKeys, useConfig, useRunnerSkills } from '@/api/queries'
import { SkillDetailBody } from '@/components/skill-detail'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { searchSkills, skillKey } from '@/lib/skills'
import { RUNNERS } from './new-task-form'
import type { Runner } from '@open-mercato/cezar-api-client'

/** Read-only inventory for the runner and account that will use the skills. */
export function SkillsRoute() {
  const config = useConfig()
  const [pickedRunner, setRunner] = useState<Runner | null>(null)
  const [account, setAccount] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [params] = useSearchParams()
  const runner = pickedRunner ?? config.data?.defaultRunner ?? 'claude'
  const accounts = useAgentAccounts()
  const query = useRunnerSkills(pickedRunner ?? config.data?.defaultRunner, account)
  const client = useQueryClient()
  const key = queryKeys.runnerSkills(runner, account)
  const refresh = async () => {
    setRefreshing(true)
    try { client.setQueryData(key, await getRunnerSkills(runner, account, { refresh: true })) }
    catch (error) { toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }) }
    finally { setRefreshing(false) }
  }
  return (
    <div data-route="skills" className="grid min-h-full content-start gap-6 p-[clamp(1rem,3vw,2.25rem)]">
      <h1 className="text-2xl">Skills</h1>
      <div className="flex flex-wrap items-center gap-3">
        <label className="grid gap-1">Runner
          <select aria-label="Runner" className="min-h-11 rounded border border-border bg-card px-3 text-base" value={runner}
            onChange={(event) => { setRunner(event.target.value as Runner); setAccount(null) }}>
            {RUNNERS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
        </label>
        <label className="grid gap-1">Account
          <select aria-label="Account" className="min-h-11 rounded border border-border bg-card px-3 text-base" value={account ?? ''}
            onChange={(event) => setAccount(event.target.value || null)}>
            <option value="">Project default</option>
            {accounts.accounts.filter((entry) => entry.provider === runner).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
        </label>
        <Button onClick={() => void refresh()} disabled={refreshing} data-slot="skills-refresh">Re-read</Button>
      </div>
      <Input aria-label="Search skills" placeholder="Search skills…" value={search} onChange={(event) => setSearch(event.target.value)} />
      {query.unchecked ? <p role="status">Skill list unavailable. {query.list?.reason ?? query.error?.message} You can still type a skill id when starting a task.</p> : null}
      {query.list?.problems.map((problem, index) => <p role="alert" key={index}>{problem.message}{problem.path ? ` · ${problem.path}` : ''}</p>)}
      <div data-slot="skills-list" className="grid gap-3">
        {searchSkills(query.data ?? [], search).map((skill) => (
          <details key={skillKey(skill)} data-slot="skill-row" data-skill={skill.id} name="skill-details"
            open={params.get('skill') === skill.id || undefined} className="rounded-lg border border-border bg-card p-3">
            <summary className="min-h-11 cursor-pointer break-words focus-visible:outline-2 active:bg-accent-strong/10">
              <span className="font-semibold">{skill.name}</span>
              {skill.description ? <span className="block text-muted-foreground">{skill.description}</span> : null}
              {skill.path ? <span className="block break-all font-mono text-xs">{skill.path}</span> : null}
            </summary>
            <SkillDetailBody skill={skill} />
          </details>
        ))}
        {query.data?.length === 0 && !query.unchecked ? <p>No skills reported by this runner and account.</p> : null}
      </div>
    </div>
  )
}
