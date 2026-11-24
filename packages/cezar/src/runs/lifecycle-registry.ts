import { createListRegistry } from '../core/registry.ts';
import type { RunLifecycleHandlers, RunLifecycleSource } from './lifecycle.ts';

/**
 * Process-wide run-lifecycle listeners (spec 2026-11-24-plugin-loader-and-runner-kit § 2). A
 * plugin registers handlers once; every `RunStore` the process opens after the boot boundary
 * seals this registry subscribes them, and unsubscribes them when it closes.
 */
const listeners = createListRegistry<RunLifecycleHandlers>({
  name: 'Run lifecycle listeners',
  bootHint: 'register every listener, then call sealRunLifecycleListeners() at the runtime boot boundary.',
});

/** Add one listener. Registering the same handlers object again does nothing. */
export function registerRunLifecycleListener(handlers: RunLifecycleHandlers): void { listeners.register(handlers); }

/** Throws what `registerRunLifecycleListener` would throw, without registering. */
export function checkRunLifecycleListenerRegistration(handlers: RunLifecycleHandlers): void { listeners.check(handlers); }

/** Finish registration at the process boot boundary. */
export function sealRunLifecycleListeners(): void { listeners.seal(); }

/** Whether the registry is sealed. Never throws. */
export function runLifecycleListenersSealed(): boolean { return listeners.isSealed(); }

/** The registered listeners, in registration order. Throws until sealed. */
export function registeredRunLifecycleListeners(): RunLifecycleHandlers[] { return listeners.values(); }

/**
 * Subscribe every registered listener to one store's lifecycle and return their unsubscribe
 * handles. An unsealed registry (a test that never boots the runtime) attaches nothing.
 */
export function attachRunLifecycleListeners(lifecycle: RunLifecycleSource): Array<() => void> {
  if (!runLifecycleListenersSealed()) return [];
  return registeredRunLifecycleListeners().map(handlers => lifecycle.subscribe(handlers));
}
