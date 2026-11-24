import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunLifecycleHandlers } from './lifecycle.ts';

const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh registry and the store module that reads it. */
async function fresh() {
  vi.resetModules();
  const registry = await import('./lifecycle-registry.ts');
  const { RunStore } = await import('./store.ts');
  const open = () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-lifecycle-registry-'));
    dirs.push(dir);
    const store = RunStore.open(dir, { keepLive: true });
    closers.push(() => store.close());
    return store;
  };
  return { ...registry, open };
}

function recorder() {
  const seen: string[] = [];
  const handlers: RunLifecycleHandlers = {
    'run.created': ({ run }) => { seen.push(`created:${run.title}`); },
    'store.closed': () => { seen.push('closed'); },
  };
  return { seen, handlers };
}

describe('run lifecycle listener registry', () => {
  it('fails closed until sealed, keeps order, ignores a repeated reference and refuses late entries', async () => {
    const registry = await fresh();
    const a: RunLifecycleHandlers = {}, b: RunLifecycleHandlers = {};
    expect(registry.runLifecycleListenersSealed()).toBe(false);
    expect(() => registry.registeredRunLifecycleListeners()).toThrow(/Run lifecycle listeners is unsealed/);
    registry.registerRunLifecycleListener(a);
    registry.registerRunLifecycleListener(b);
    registry.registerRunLifecycleListener(a);
    registry.sealRunLifecycleListeners();
    expect(registry.registeredRunLifecycleListeners()).toEqual([a, b]);
    registry.registerRunLifecycleListener(a);
    expect(() => registry.registerRunLifecycleListener({})).toThrow(/sealed/);
    expect(() => registry.checkRunLifecycleListenerRegistration({})).toThrow(/sealed/);
    expect(() => registry.checkRunLifecycleListenerRegistration(a)).not.toThrow();
  });

  it('delivers to every store opened after seal, and unsubscribes each at close after store.closed', async () => {
    const registry = await fresh();
    const { seen, handlers } = recorder();
    registry.registerRunLifecycleListener(handlers);
    registry.sealRunLifecycleListeners();
    const first = registry.open();
    const second = registry.open();
    first.createRun({ title: 'one', workflow: 'w', task: 't', steps: [] });
    second.createRun({ title: 'two', workflow: 'w', task: 't', steps: [] });
    expect(seen).toEqual(['created:one', 'created:two']);

    first.close();
    first.close();
    expect(seen).toEqual(['created:one', 'created:two', 'closed']);
    second.createRun({ title: 'three', workflow: 'w', task: 't', steps: [] });
    second.close();
    second.close();
    expect(seen).toEqual(['created:one', 'created:two', 'closed', 'created:three', 'closed']);
  });

  it('attaches nothing to a store while the registry is unsealed', async () => {
    const registry = await fresh();
    const { seen, handlers } = recorder();
    registry.registerRunLifecycleListener(handlers);
    const store = registry.open();
    store.createRun({ title: 'one', workflow: 'w', task: 't', steps: [] });
    store.close();
    expect(seen).toEqual([]);
  });
});
