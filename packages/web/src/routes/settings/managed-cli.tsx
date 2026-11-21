import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RunnerInstallAction, RunnerInstallStatus } from '@open-mercato/cezar-api-client/contract/runner-install'
import { changeRunnerInstall, getRunnerInstall } from '@/api/runner-install'
import { useHealth } from '@/api/queries'
import { Button } from '@/components/ui/button'

const PHASE_TEXT: Record<RunnerInstallStatus['phase'], string> = {
  idle: '', checking: 'Checking for updates…', downloading: 'Downloading CLI…', verifying: 'Verifying CLI…',
  extracting: 'Extracting CLI…', activating: 'Activating CLI…', removing: 'Removing CLI…', failed: '',
}

/** Install state is shared by accounts. Hosted controls use the same grant as browser sign-in. */
function useManagedCli(runner: string) {
  const allowed = useHealth().data?.capabilities?.settingsAdmin === true
  const client = useQueryClient()
  const queryKey = ['runner-install', runner]
  const status = useQuery({
    queryKey, queryFn: () => getRunnerInstall(runner), enabled: allowed, retry: false,
    refetchInterval: query => {
      if (query.state.error) return false
      const phase = query.state.data?.phase
      return phase && phase !== 'idle' && phase !== 'failed' ? 1000 : 60_000
    },
  })
  const action = useMutation({
    mutationFn: (operation: RunnerInstallAction) => changeRunnerInstall(runner, operation), retry: false,
    onSuccess: data => { client.setQueryData(queryKey, data) },
  })
  const data = status.data
  const busy = action.isPending || (!!data && data.phase !== 'idle' && data.phase !== 'failed')
  const error = action.error?.message ?? status.error?.message ?? data?.error
  return { allowed, data, busy, error, action, status }
}

type InstallationState = ReturnType<typeof useManagedCli>

function CliActions({ state }: { state: InstallationState }) {
  const { data, busy, action, status } = state
  if (data?.supported === false) return <p>This host is not supported by the CLI installer.</p>
  const installed = !!data?.installedVersion
  return <div className="flex flex-wrap gap-2">
    <Button className="min-h-11 active:opacity-80" disabled={busy || !data} onClick={() => action.mutate(installed ? 'update' : 'install')}>
      {installed ? 'Update CLI' : 'Install CLI'}
    </Button>
    {installed ? <Button className="min-h-11 active:opacity-80" variant="outline" disabled={busy} onClick={() => action.mutate('remove')}>Remove CLI</Button> : null}
    <Button className="min-h-11 active:opacity-80" variant="outline" disabled={busy} onClick={() => {
      if (status.isError) void status.refetch()
      else action.mutate('check')
    }}>Check for updates</Button>
  </div>
}

export function ManagedCli({ runner }: { runner: string }) {
  const state = useManagedCli(runner)
  const { allowed, data, busy, error } = state
  if (!allowed) return null
  return <section aria-label="CLI installation" className="grid gap-3">
    <p role="status" className="text-sm text-muted-foreground">
      {data?.installedVersion ? `Installed CLI ${data.installedVersion}` : 'CLI not installed'}
      {data?.latestVersion ? ` · Latest ${data.latestVersion}` : ''}
      {busy && data ? ` · ${PHASE_TEXT[data.phase]}` : ''}
    </p>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <CliActions state={state} />
    {data?.installedVersion ? <p className="text-sm text-muted-foreground">Removing the CLI keeps account data and lets running tasks finish.</p> : null}
  </section>
}
