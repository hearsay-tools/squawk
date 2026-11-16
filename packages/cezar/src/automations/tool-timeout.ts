import { AUTOMATION_TOOL_TIMEOUT_MS } from '../core/github-request-limits.ts';

/** Bound admission and preview work, and invalidate late preview evidence. */
export async function withAutomationToolDeadline<T>(session: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController();
  const signal = AbortSignal.any([session, deadline.signal]);
  let cancel = () => {};
  // bound: two provider scan budgets plus discovery and queueing, shared with the client.
  const timer = setTimeout(() => deadline.abort(new Error('Automation tool preview timed out.')), AUTOMATION_TOOL_TIMEOUT_MS);
  try {
    signal.throwIfAborted();
    const aborted = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
    });
    return await Promise.race([work(signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
