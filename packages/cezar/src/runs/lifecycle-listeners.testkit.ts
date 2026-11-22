import type { RunLifecycleEventType, RunLifecycleHandlers, RunLifecycleSource, RunUpdateSource } from './lifecycle.ts';
import type { RunRecord } from './store.ts';

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

/**
 * Observe every record write, as the store emitter's `run` event did: `run.created` for a new
 * record, `run.updated` for every other write, with the update's source. The returned function
 * unsubscribes. `run` is the write's value, as the lifecycle delivers it; re-read the store for the
 * current record.
 */
export function onRunWrite(source: RunLifecycleSource, handler: (run: RunRecord, source?: RunUpdateSource) => void): () => void {
  return source.subscribe({
    'run.created': ({ run }) => handler(run),
    'run.updated': ({ run, source: updateSource }) => handler(run, updateSource),
  });
}
