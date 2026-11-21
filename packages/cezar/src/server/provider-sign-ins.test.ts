import { expect, it, vi } from 'vitest';
import { providerSignInSchema } from '@open-mercato/cezar-contract/workspace';
import { ProviderSignIns } from './provider-sign-ins.ts';
import { createProviderSignInRoutes } from './provider-sign-in-routes.ts';
import { registerRunner } from '../core/runner-registry.ts';
import { antigravityRunner } from '../runners/antigravity/definition.ts';
import { ProviderAuthService } from '../core/provider-auth.ts';

it('joins account starts, erases the consent URL on completion and keeps other accounts independent', async () => {
  const manager = new ProviderSignIns();
  let finish!: () => void;
  const completion = new Promise<void>(resolve => { finish = resolve; });
  const create = vi.fn(async () => ({ url: 'https://accounts.google.com/o/oauth2/auth?state=fixture', completion, redirect: vi.fn(), close: vi.fn(async () => {}) }));
  const connected = vi.fn(async () => {});
  const [first, same, other] = await Promise.all([manager.start('one', create, connected), manager.start('one', create, connected), manager.start('two', create, connected)]);
  expect(first).toEqual(same); expect(other.id).not.toBe(first.id); expect(create).toHaveBeenCalledTimes(2);
  expect(providerSignInSchema.parse(manager.get(first.id)).state).toBe('waiting');
  finish();
  // bound: only the native-completion continuation and its cache refresh remain; no I/O.
  await vi.waitFor(() => expect(manager.get(first.id)).toEqual({ id: first.id, state: 'connected' }));
  expect(JSON.stringify(manager.get(first.id))).not.toContain('accounts.google.com');
  expect(connected).toHaveBeenCalledTimes(2);
  await manager.cancel(first.id); await manager.cancel(other.id);
});

it('cancellation wins over a later native completion', async () => {
  const manager = new ProviderSignIns(); let finish!: () => void;
  const connected = vi.fn(async () => {}); const close = vi.fn(async () => {});
  const flow = await manager.start('one', async () => ({ url: 'https://example.test', completion: new Promise<void>(resolve => { finish = resolve; }), redirect: async () => {}, close }), connected);
  await manager.cancel(flow.id); finish(); await Promise.resolve();
  expect(manager.get(flow.id)).toEqual({ id: flow.id, state: 'cancelled' });
  expect(connected).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
});

it('expires a waiting flow and releases it even if native cleanup rejects', async () => {
  vi.useFakeTimers();
  try {
    const manager = new ProviderSignIns();
    const close = vi.fn(async () => { throw new Error('native cleanup'); });
    const flow = await manager.start('one', async () => ({ url: 'https://example.test',
      completion: new Promise<void>(() => {}), redirect: async () => {}, close }), async () => {});
    await vi.advanceTimersByTimeAsync(300_000);
    expect(close).toHaveBeenCalledOnce(); expect(manager.get(flow.id)).toBeUndefined();
  } finally { vi.useRealTimers(); }
});

it('refuses all browser endpoints in hosted mode before resolving an account', async () => {
  registerRunner(antigravityRunner);
  const resolve = vi.fn(async () => ({ error: 'should not run' }));
  const app = createProviderSignInRoutes({ localHandoff: () => false, resolve, auth: new ProviderAuthService(), invalidateModels: () => {} });
  const response = await app.request('/providers/sign-in/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'antigravity', profileId: 'private-account' }) });
  expect(response.status).toBe(409); expect(response.headers.get('cache-control')).toBe('no-store'); expect(resolve).not.toHaveBeenCalled();
});

it('starts, replays and observes the selected native account through the typed API', async () => {
  let finish!: () => void;
  const native = { url: 'https://accounts.google.com/o/oauth2/auth?state=fixture', completion: new Promise<void>(resolve => { finish = resolve; }),
    redirect: vi.fn(async (_url: string) => { finish(); }), close: vi.fn(async () => {}) };
  const create = vi.fn(async (_home?: string) => native);
  registerRunner(antigravityRunner);
  const loader = vi.spyOn(antigravityRunner, 'loadBrowserSignIn').mockResolvedValue(create);
  const auth = new ProviderAuthService();
  vi.spyOn(auth, 'profileStatus').mockResolvedValue({ provider: 'antigravity', status: 'connected', profileId: 'work' });
  const invalidate = vi.fn();
  const app = createProviderSignInRoutes({ localHandoff: () => true, auth, invalidateModels: invalidate,
    resolve: async () => ({ profile: { id: 'work', provider: 'antigravity', label: 'Work', configDir: '/private/work', path: '/private/work', isDefault: false } }) });
  try {
    const started = await app.request('/providers/sign-in/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'antigravity', profileId: 'work' }) });
    const flow = providerSignInSchema.parse(await started.json());
    expect(started.headers.get('cache-control')).toBe('no-store'); expect(create).toHaveBeenCalledWith('/private/work');
    const redirected = await app.request(`/providers/sign-in/${flow.id}/redirect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirectUrl: 'http://127.0.0.1:5555/?code=fixture' }) });
    expect(redirected.status).toBe(200);
    expect(native.redirect).toHaveBeenCalledWith('http://127.0.0.1:5555/?code=fixture');
    // bound: native completion awaits only the injected account cache refresh before publishing.
    await vi.waitFor(async () => expect(await (await app.request(`/providers/sign-in/${flow.id}`)).json()).toEqual({ id: flow.id, state: 'connected' }));
    expect(invalidate).toHaveBeenCalledWith('antigravity');
    expect(auth.profileStatus).toHaveBeenCalledWith('antigravity', { id: 'work', configDir: '/private/work' });
  } finally { loader.mockRestore(); }
});
