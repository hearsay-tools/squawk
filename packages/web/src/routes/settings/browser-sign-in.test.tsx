import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { BrowserSignInButton } from './browser-sign-in'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const id = 'b562e386-737d-4194-832c-1f795cc5e586'
const consent = 'https://accounts.google.com/o/oauth2/auth?state=fixture'
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
  render(<QueryClientProvider client={createQueryClient()}><BrowserSignInButton provider="antigravity" profileId="work" label="Work" /></QueryClientProvider>)
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
  render(<QueryClientProvider client={createQueryClient()}><BrowserSignInButton provider="antigravity" label="Personal" /></QueryClientProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await screen.findByRole('link', { name: 'Open Google sign-in' })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(calls.some(call => call.method === 'DELETE')).toBe(true))
})
