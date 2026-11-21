import { expect, it, vi } from 'vitest';
import { providerSignInSchema } from '@open-mercato/cezar-contract/workspace';
import { ProviderSignIns } from './provider-sign-ins.ts';
import { createProviderSignInRoutes } from './provider-sign-in-routes.ts';
import { registerRunner } from '../core/runner-registry.ts';
import { antigravityRunner } from '../runners/antigravity/definition.ts';
import { ProviderAuthService } from '../core/provider-auth.ts';
import { resolveCapabilities } from './capabilities.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { enableRemoteSettings, disableRemoteSettings } from '../remote-settings.ts';
import { BrowserSignInStartError } from '../core/browser-sign-in-error.ts';

// Keep the old gate available to the red proof over the pre-fix source.
const permissions = (local = true, admin = local) => ({ localHandoff: () => local, settingsAdmin: () => admin });

it.each([true, false])('shows only sanitized startup causes through the API (safe error=%s)', async safe => {
  registerRunner(antigravityRunner);
  const message = 'Antigravity personal sign-in could not start. Agent exited (code 1): Unknown flag uid https://accounts.google.com/o/oauth2/auth?state=private-state token=private-token';
  const create = vi.fn().mockRejectedValue(safe ? new BrowserSignInStartError(message) : new Error(message));
  const loader = vi.spyOn(antigravityRunner, 'loadBrowserSignIn').mockResolvedValue(create);
  const app = createProviderSignInRoutes({ ...permissions(), auth: new ProviderAuthService(), invalidateModels: () => {},
    resolve: async () => ({ profile: { id: 'work', provider: 'antigravity', label: 'Work', configDir: '/private/work', path: '/private/work', isDefault: false } }) });
  try {
    const response = await app.request('/providers/sign-in/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'antigravity', profileId: 'work' }) });
    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.error).toBe(safe ? 'Antigravity personal sign-in could not start. Agent exited (code 1): Unknown flag uid [URL redacted] token=[redacted]' : 'Browser sign-in could not start. Check the installation and try again.');
    expect(JSON.stringify(body)).not.toMatch(/accounts\.google|private-state|private-token/);
  } finally { loader.mockRestore(); }
});

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

it('refuses every browser endpoint without settings administration before resolving an account', async () => {
  registerRunner(antigravityRunner);
  const resolve = vi.fn(async () => ({ error: 'should not run' }));
  const app = createProviderSignInRoutes({ ...permissions(false), resolve, auth: new ProviderAuthService(), invalidateModels: () => {} });
  for (const [method, path] of [['POST', 'start'], ['GET', 'unknown'], ['POST', 'unknown/redirect'], ['DELETE', 'unknown']] as const) {
    const response = await app.request(`/providers/sign-in/${path}`, { method });
    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('remote-settings enable') });
  }
  expect(resolve).not.toHaveBeenCalled();
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
  const app = createProviderSignInRoutes({ ...permissions(), auth, invalidateModels: invalidate,
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

it.each([undefined, 'work'])('allows hosted sign-in for account %s only while its listen port has the host grant', async profileId => {
  registerRunner(antigravityRunner);
  const home = testHome();
  const port = 4357;
  await enableRemoteSettings(port, {}, new Date(), home);
  const caps = () => resolveCapabilities({ CEZ_REMOTE: '1' }, '127.0.0.1', port, home);
  const native = { url: 'https://accounts.google.com/o/oauth2/auth?state=fixture', completion: new Promise<void>(() => {}),
    redirect: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const create = vi.fn(async (_home?: string) => native);
  const loader = vi.spyOn(antigravityRunner, 'loadBrowserSignIn').mockResolvedValue(create);
  const resolve = vi.fn(async () => ({ profile: { id: profileId ?? 'default', provider: 'antigravity', label: 'Account',
    configDir: '/private/account', path: '/private/account', isDefault: profileId === undefined } }));
  const options = { localHandoff: () => caps().localHandoff,
    settingsAdmin: () => caps().settingsAdmin, resolve, auth: new ProviderAuthService(), invalidateModels: () => {} };
  const app = createProviderSignInRoutes(options);
  try {
    expect(caps()).toMatchObject({ localHandoff: false, settingsAdmin: true });
    const started = await app.request('/providers/sign-in/start', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'antigravity', ...(profileId ? { profileId } : {}) }) });
    expect(started.status).toBe(200);
    const flow = providerSignInSchema.parse(await started.json());
    expect(flow).toMatchObject({ state: 'waiting', url: native.url });
    expect(create).toHaveBeenCalledWith(profileId ? '/private/account' : undefined);
    expect((await app.request(`/providers/sign-in/${flow.id}`)).status).toBe(200);
    expect((await app.request(`/providers/sign-in/${flow.id}/redirect`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirectUrl: 'http://127.0.0.1:5555/?state=fixture&code=fixture' }) })).status).toBe(200);
    await disableRemoteSettings({}, port, home);
    for (const [method, path] of [['POST', 'start'], ['GET', flow.id], ['POST', `${flow.id}/redirect`], ['DELETE', flow.id]] as const) {
      expect((await app.request(`/providers/sign-in/${path}`, { method })).status).toBe(409);
    }
    expect(resolve).toHaveBeenCalledOnce();
    await enableRemoteSettings(port, {}, new Date(), home);
    expect((await app.request(`/providers/sign-in/${flow.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(native.close).toHaveBeenCalledOnce();
  } finally { await disableRemoteSettings({}, port, home); loader.mockRestore(); }
});
