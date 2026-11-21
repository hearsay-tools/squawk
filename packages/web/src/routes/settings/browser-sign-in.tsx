import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ProviderSignIn } from '@open-mercato/cezar-api-client'
import { cancelProviderSignIn, getProviderSignIn, replayProviderSignIn, startProviderSignIn } from '@/api/client'
import { workspaceQueryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/** Consent and pasted callbacks stay in component memory; neither enters persisted UI state. */
export function BrowserSignInButton({ provider, profileId, label }: { provider: string; profileId?: string; label: string }) {
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const [flow, setFlow] = useState<ProviderSignIn | null>(null)
  const [redirect, setRedirect] = useState('')
  const active = useRef<ProviderSignIn | null>(null)
  const mounted = useRef(true)
  const close = () => {
    openRef.current = false
    const current = active.current
    active.current = null
    if (current?.state === 'waiting') void cancelProviderSignIn(current.id).catch(() => {})
    setFlow(null); setRedirect(''); setOpen(false)
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const current = active.current
      if (current?.state === 'waiting') void cancelProviderSignIn(current.id).catch(() => {})
    }
  }, [])
  const start = useMutation({
    mutationFn: () => startProviderSignIn(provider, profileId), retry: false,
    onSuccess: result => {
      if (!mounted.current || !openRef.current) { void cancelProviderSignIn(result.id).catch(() => {}); return }
      active.current = result; setFlow(result)
    },
  })
  const openRef = useRef(open)
  openRef.current = open
  const status = useQuery({
    queryKey: ['browser-sign-in', flow?.id],
    queryFn: () => getProviderSignIn(flow!.id),
    enabled: open && flow?.state === 'waiting', retry: false,
    refetchInterval: query => query.state.error || (query.state.data?.state && query.state.data.state !== 'waiting') ? false : 1000,
    gcTime: 0,
  })
  const result = status.data ?? flow
  const replay = useMutation({
    mutationFn: () => replayProviderSignIn(flow!.id, redirect), retry: false,
    onSuccess: () => { setRedirect(''); void status.refetch() },
  })
  useEffect(() => {
    if (result?.state !== 'connected') return
    active.current = result
    setFlow(result)
    void Promise.all([
      client.invalidateQueries({ queryKey: workspaceQueryKeys.agentProfiles }),
      client.invalidateQueries({ queryKey: workspaceQueryKeys.providerStatus }),
      client.invalidateQueries({ queryKey: workspaceQueryKeys.models(provider) }),
    ])
  }, [result, client, provider])
  const error = start.error ?? replay.error ?? status.error
  return <>
    <Button type="button" size="sm" data-action="account-connect" onClick={() => {
      setOpen(true); openRef.current = true; start.reset(); replay.reset(); start.mutate()
    }}>Connect</Button>
    <Dialog open={open} onOpenChange={value => { if (!value) close() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sign in to {label}</DialogTitle>
          <DialogDescription>Use a personal Google account. Business and agent-platform sign-in are not supported.</DialogDescription>
        </DialogHeader>
        {start.isPending ? <p role="status">Preparing sign-in…</p> : null}
        {result?.state === 'waiting' ? <div className="grid min-w-0 gap-3">
          <a href={result.url} target="_blank" rel="noopener noreferrer" className="text-action underline">Open Google sign-in</a>
          <p className="text-sm text-muted-foreground">After consent, sign-in completes here. If your browser cannot reach the host’s 127.0.0.1 address, paste the full failed redirect URL below.</p>
          <label className="grid gap-2">Redirect URL
            <Input type="url" autoComplete="off" spellCheck={false} value={redirect} onChange={event => setRedirect(event.target.value)} />
          </label>
          <Button disabled={!redirect.trim() || replay.isPending} onClick={() => replay.mutate()}>Complete sign-in</Button>
        </div> : null}
        {result?.state === 'connected' ? <p role="status">Connected.</p> : null}
        {result?.state === 'failed' ? <p role="alert">{result.error}</p> : null}
        {result?.state === 'cancelled' ? <p role="status">Sign-in cancelled. Close this window and Connect again.</p> : null}
        {error ? <p role="alert">{error.message}</p> : null}
        <DialogFooter><Button variant="outline" onClick={close}>{result?.state === 'connected' ? 'Done' : 'Cancel'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
