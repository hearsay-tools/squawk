import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { queryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { BrowserSignInButton } from './browser-sign-in'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const id = 'b562e386-737d-4194-832c-1f795cc5e586'
const consent = 'https://accounts.google.com/o/oauth2/auth?state=fixture'
const signInClient = (localHandoff = true, settingsAdmin = true) => {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { capabilities: { localHandoff, settingsAdmin } })
  return client
}
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

it('opens consent for the chosen account and submits a pasted remote redirect', async () => {
  let connected = false
  const requests: Array<{ url: string; method: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ url, method, body })
    if (url.endsWith('/redirect')) { connected = true; return response({ id, state: 'connected' }) }
    return response(connected ? { id, state: 'connected' } : { id, state: 'waiting', url: consent })
  }))
  render(<QueryClientProvider client={signInClient()}><BrowserSignInButton provider="antigravity" profileId="work" label="Work" /></QueryClientProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  expect((await screen.findByRole('link', { name: 'Open Google sign-in' })).getAttribute('href')).toBe(consent)
  expect(requests[0]).toMatchObject({ method: 'POST', body: { provider: 'antigravity', profileId: 'work' } })
  const redirect = 'http://127.0.0.1:12345/?state=fixture&code=fixture-only'
  fireEvent.change(screen.getByRole('textbox', { name: 'Redirect URL' }), { target: { value: redirect } })
  fireEvent.click(screen.getByRole('button', { name: 'Complete sign-in' }))
  expect(await screen.findByText('Connected.')).toBeTruthy()
  expect(requests.find(request => request.url.endsWith('/redirect'))?.body).toEqual({ redirectUrl: redirect })
  expect(screen.queryByRole('textbox', { name: 'Redirect URL' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('cancels the native flow when the consent window closes', async () => {
  const calls: RequestInit[] = []
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { calls.push(init ?? {}); return response({ id, state: 'waiting', url: consent }) }))
  render(<QueryClientProvider client={signInClient()}><BrowserSignInButton provider="antigravity" label="Personal" /></QueryClientProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await screen.findByRole('link', { name: 'Open Google sign-in' })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(calls.some(call => call.method === 'DELETE')).toBe(true))
})

it('cancels a late start after close before allowing another attempt', async () => {
  let release!: (value: Response) => void
  let starts = 0
  const cancelled: string[] = []
  const nextId = 'dc7ab71d-9973-4263-941f-7e7a0d7d00ae'
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'DELETE') { cancelled.push(String(input)); return response({ id, state: 'cancelled' }) }
    if (init?.method === 'POST' && ++starts === 1) return new Promise<Response>(resolve => { release = resolve })
    return response({ id: nextId, state: 'waiting', url: `${consent}-next` })
  }))
  render(<QueryClientProvider client={signInClient()}><BrowserSignInButton provider="antigravity" label="Personal" /></QueryClientProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await screen.findByText('Preparing sign-in…')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => { release(response({ id, state: 'waiting', url: consent })) })
  await waitFor(() => expect(cancelled).toEqual([`/api/v1/providers/sign-in/${id}`]))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  expect((await screen.findByRole('link', { name: 'Open Google sign-in' })).getAttribute('href')).toBe(`${consent}-next`)
})

it('offers status retry after a transient read failure and observes native completion', async () => {
  let reads = 0
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return response({ id, state: 'waiting', url: consent })
    if (++reads === 1) return new Response(JSON.stringify({ error: 'Temporary failure' }), { status: 503 })
    return response({ id, state: 'connected' })
  }))
  render(<QueryClientProvider client={signInClient()}><BrowserSignInButton provider="antigravity" label="Personal" /></QueryClientProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry status' }))
  expect(await screen.findByText('Connected.')).toBeTruthy()
})

it('requires pasted redirects on a hosted cockpit with settings administration', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ id, state: 'waiting', url: consent })))
  render(<QueryClientProvider client={signInClient(false)}><BrowserSignInButton provider="antigravity" label="Personal" /></QueryClientProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await screen.findByRole('link', { name: 'Open Google sign-in' })
  expect(screen.getByText(/Open the sign-in link in your browser/).textContent).toContain('Copy that full address and paste it below')
  expect(screen.queryByText(/sign-in completes here/)).toBeNull()
  expect(screen.getByRole('textbox', { name: 'Redirect URL' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
})

it('hides browser sign-in without settings administration', () => {
  render(<QueryClientProvider client={signInClient(false, false)}><BrowserSignInButton provider="antigravity" label="Personal" /></QueryClientProvider>)
  expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
})
