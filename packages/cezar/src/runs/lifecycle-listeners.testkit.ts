import type { RunLifecycleEventType, RunLifecycleHandlers, RunLifecycleSource } from './lifecycle.ts';

/**
 * Count the live subscriptions `source` holds for one event type, as `listenerCount` counted the
 * store emitter's listeners. Only subscriptions made after this call are counted, so call it before
 * the code under test subscribes; an unsubscribe removes its subscription from the count.
 */
export function lifecycleListeners(source: RunLifecycleSource): (type: RunLifecycleEventType) => number {
  const live = new Set<RunLifecycleHandlers>();
  const subscribe = source.subscribe.bind(source);
  source.subscribe = (handlers) => {
    const unsubscribe = subscribe(handlers);
    live.add(handlers);
    return () => { live.delete(handlers); unsubscribe(); };
  };
  return (type) => [...live].filter((handlers) => handlers[type]).length;
}
