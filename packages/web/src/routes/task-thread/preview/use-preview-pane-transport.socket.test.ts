import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PreviewServer } from '@open-mercato/cezar-api-client'
import { FakeWebSocket } from '@/api/preview-socket.testkit'
import type { PreviewPaneProps } from './preview-pane'
import { usePreviewPaneTransport } from './use-preview-pane-transport'

// The real socket and the real page-activity store under the hook (hearsay-tools/squawk#4354).
vi.mock('@/lib/project-router', () => ({ useActiveProjectId: () => undefined }))
vi.mock('./use-media-query', () => ({ PREVIEW_PHONE_QUERY: 'phone', useMediaQuery: () => false }))
vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))

const server: PreviewServer = { port: 5173, command: 'npm run dev', cwd: '.', label: 'web', registeredAt: '2026-10-01T00:00:00Z', answeredAtRegistration: false }
let visibility: DocumentVisibilityState = 'visible'
const setVisibility = (next: DocumentVisibilityState) => act(() => {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
})
const sent = (socket: FakeWebSocket) => socket.sent.map(data => (JSON.parse(data) as { t: string }).t)

beforeEach(() => {
  FakeWebSocket.instances = []
  visibility = 'visible'
  vi.useFakeTimers({ now: 10_000 })
  vi.stubGlobal('WebSocket', FakeWebSocket)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'visibilityState')
})

it('holds a Stop clicked while the tab return reopens the socket and sends it once the socket opens', () => {
  const props: PreviewPaneProps = { run: { id: 'run' } as PreviewPaneProps['run'], servers: [server], request: { port: 5173 }, onClose: vi.fn() }
  const hook = renderHook(() => usePreviewPaneTransport(props))
  act(() => FakeWebSocket.instances[0]!.open())
  act(() => FakeWebSocket.instances[0]!.message(JSON.stringify({ t: 'state', stage: 'streaming', adopted: false })))
  expect(hook.result.current.connected).toBe(true)

  setVisibility('hidden')
  setVisibility('visible')
  const reopened = FakeWebSocket.instances[1]!
  expect(reopened.readyState).toBe(0)
  expect(hook.result.current.connected).toBe(false)

  act(() => hook.result.current.actions.stop(5173))
  expect(reopened.sent).toEqual([])
  act(() => reopened.open())
  expect(sent(reopened)).toEqual(['open', 'stop'])
  expect(JSON.parse(reopened.sent[1]!)).toEqual({ t: 'stop', port: 5173 })
  expect(hook.result.current.connected).toBe(true)
})

it('drops held actions when the connection gives up instead of firing them on a later reconnect', () => {
  const props: PreviewPaneProps = { run: { id: 'run' } as PreviewPaneProps['run'], servers: [server], request: { port: 5173 }, onClose: vi.fn() }
  const hook = renderHook(() => usePreviewPaneTransport(props))
  act(() => hook.result.current.actions.stop(5173))
  act(() => FakeWebSocket.instances[0]!.drop())
  act(() => { vi.advanceTimersByTime(1_000) }) // the socket's retry before its second upgrade
  act(() => FakeWebSocket.instances[1]!.drop())
  expect(hook.result.current.transport.state).toBe('blocked')
  act(() => hook.result.current.reconnect())
  act(() => FakeWebSocket.instances[2]!.open())
  expect(sent(FakeWebSocket.instances[2]!)).toEqual(['open'])
})
