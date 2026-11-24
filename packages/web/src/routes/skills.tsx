import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { getRunnerSkills } from '@/api/client'
import { runnerDisplayName, useResolvedRunner, useRunners } from '@/api/runners'
import { useAgentAccounts } from '@/api/agent-accounts'
import { queryKeys, useConfig, useRunnerSkills } from '@/api/queries'
import { RefreshCwIcon, SearchIcon, TriangleAlertIcon } from '@/components/design-icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { searchSkills } from '@/lib/skills'
import { cn } from '@/lib/utils'
import { groupRunnerSkills, SkillGroups } from './skills-list'
import type { Runner } from '@open-mercato/cezar-api-client'
import type { RunnerSkill } from '@open-mercato/cezar-api-client/contract/runner-skills'

/** Read-only inventory for the runner and account that will use the skills. */
export function SkillsRoute() {
  const config = useConfig()
  const [pickedRunner, setRunner] = useState<Runner | null>(null)
  const [pickedAccount, setPickedAccount] = useState<{ runner: Runner; id: string } | null>(null)
  const [search, setSearch] = useState('')
  const [params] = useSearchParams()
  const storedRunner = pickedRunner ?? config.data?.defaultRunner
  // The runner the skills come from: a stored default whose plugin did not load resolves to the
  // runner the server runs instead. An account picked for another runner is not sent with it.
  const { runner } = useResolvedRunner(storedRunner ?? 'claude')
  const account = pickedAccount?.runner === runner ? pickedAccount.id : null
  const setAccount = (id: string | null) => setPickedAccount(id === null ? null : { runner, id })
  const query = useRunnerSkills(storedRunner, account)
  const refresh = useRereadSkills(runner, query.account)
  const skills = query.data ?? []
  return (
    <div data-route="skills" className="mx-auto grid min-h-full w-full max-w-[1100px] grid-cols-1 content-start gap-5 px-[18px] py-6 md:p-9 max-md:[padding-block-end:5rem]">
      <header>
        <h1 className="text-[25px] font-semibold tracking-tight md:text-[30px]">Skills</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">The skills each agent loads in this project, as its runner reports them.</p>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <RunnerSwitch runner={runner} onChange={(next) => { setRunner(next); setAccount(null) }} />
        <AccountSelect runner={runner} account={account} onChange={setAccount} />
        <span className="ml-auto text-xs text-soft-foreground" data-slot="skills-count">
          {query.list ? `${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}${query.list.source === 'cache' ? ' · from cache' : ''}` : null}
        </span>
        <Button variant="outline" size="sm" onClick={() => void refresh.run()} disabled={refresh.running || query.isPending} data-slot="skills-refresh">
          <RefreshCwIcon aria-hidden="true" className={cn('size-3.5', refresh.running && 'motion-safe:animate-spin')} />Re-read
        </Button>
      </div>
      <div className="relative">
        <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label="Search skills" placeholder="Filter by name or description…" value={search}
          onChange={(event) => setSearch(event.target.value)} className="h-10 bg-card pl-9 text-[13px]" />
      </div>
      <SkillNotices query={query} />
      {query.isPending
        ? <p role="status" className="text-xs text-muted-foreground">Loading skills…</p>
        : <SkillsResult skills={skills} search={search} openId={params.get('skill')} runner={runner} account={query.account ?? null} unchecked={query.unchecked} />}
    </div>
  )
}

function SkillsResult({ skills, search, openId, runner, account, unchecked }: {
  skills: RunnerSkill[]; search: string; openId: string | null; runner: Runner; account: string | null; unchecked: boolean
}) {
  if (skills.length === 0) return unchecked ? null : <p className="text-[13px] text-muted-foreground">No skills reported by this runner and account.</p>
  const matches = searchSkills(skills, search)
  if (matches.length === 0) return <p className="text-[13px] text-muted-foreground">No skills match “{search.trim()}”.</p>
  return <SkillGroups groups={groupRunnerSkills(matches)} openId={openId} searching={search.trim() !== ''} runner={runner} account={account} />
}

/** Renders once the runners list has answered, so every button shows the runner's name. */
function RunnerSwitch({ runner, onChange }: { runner: Runner; onChange: (runner: Runner) => void }) {
  const runners = useRunners().data
  if (!runners) return null
  return (
    <div role="group" aria-label="Runner" className="flex max-w-full gap-0.5 overflow-x-auto rounded-[10px] border border-border bg-card p-[3px]">
      {runners.runners.map((entry) => (
        <button key={entry.id} type="button" aria-pressed={entry.id === runner} onClick={() => onChange(entry.id)}
          className="h-8 shrink-0 rounded-[7px] px-3 text-[13px] text-muted-foreground focus-visible:outline-2 aria-pressed:bg-muted aria-pressed:font-semibold aria-pressed:text-foreground pointer-hover:text-foreground">
          {runnerDisplayName(runners, entry.id)}
        </button>
      ))}
    </div>
  )
}

/** Only a runner with saved accounts offers a choice; the project default needs no control. */
function AccountSelect({ runner, account, onChange }: { runner: Runner; account: string | null; onChange: (account: string | null) => void }) {
  const accounts = useAgentAccounts().accounts.filter((entry) => entry.provider === runner)
  if (accounts.length === 0) return null
  return (
    <select aria-label="Account" value={account ?? ''} onChange={(event) => onChange(event.target.value || null)}
      className="h-[38px] rounded-md border border-border bg-card px-2.5 text-[13px] text-foreground focus-visible:outline-2">
      <option value="">Account: project default</option>
      {accounts.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
    </select>
  )
}

function SkillNotices({ query }: { query: ReturnType<typeof useRunnerSkills> }) {
  const problems = query.list?.problems ?? []
  if (!query.unchecked && problems.length === 0) return null
  return (
    <div className="grid gap-1.5 rounded-lg border border-pending/40 bg-pending/10 px-3.5 py-2.5 text-[13px]">
      {query.unchecked && !query.isPending ? (
        <p role="status" className="flex gap-2">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-pending-strong" />
          <span>Skill list unavailable. {query.list?.reason ?? query.error?.message} You can still type a skill id when starting a task.</span>
        </p>
      ) : null}
      {problems.map((problem, index) => (
        <p role="alert" key={index} className="flex gap-2 break-words">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-pending-strong" />
          <span>{problem.message}{problem.path ? ` · ${problem.path}` : ''}</span>
        </p>
      ))}
    </div>
  )
}

function useRereadSkills(runner: Runner, account: string | null | undefined) {
  const client = useQueryClient()
  const [running, setRunning] = useState(false)
  const key = queryKeys.runnerSkills(runner, account)
  const run = async () => {
    setRunning(true)
    try {
      client.setQueryData(key, await getRunnerSkills(runner, account, { refresh: true }))
      // Omitted and explicit accounts can resolve to the same runner catalog.
      await client.invalidateQueries({ queryKey: key.slice(0, 3) })
    }
    catch (error) { toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }) }
    finally { setRunning(false) }
  }
  return { running, run }
}
