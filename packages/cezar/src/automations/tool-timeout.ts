import { GITHUB_COMMAND_TIMEOUT_MS, GITHUB_POLL_TIMEOUT_MS } from './github-poller.ts';

// Two scans cover the canonical-name retry. One command budget covers discovery
// and queueing; that wait shares the total bound rather than extending it.
export const AUTOMATION_TOOL_TIMEOUT_MS = 2 * GITHUB_POLL_TIMEOUT_MS + GITHUB_COMMAND_TIMEOUT_MS;
// Let the server return its timeout diagnostic before the transport gives up.
export const AUTOMATION_TOOL_CLIENT_TIMEOUT_MS = AUTOMATION_TOOL_TIMEOUT_MS + GITHUB_COMMAND_TIMEOUT_MS;

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
