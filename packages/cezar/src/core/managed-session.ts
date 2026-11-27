import type { AgentEvent, AgentRunner, AgentRunSpec, AgentSession, SessionOptions } from './agent-runner.ts';
import { DEFAULT_RUNNER_TIMINGS } from './runner-runtime.ts';
import { classifyProviderError } from './provider-error.ts';
import type { UiEvent } from './ui-events.ts';

/** The events that show the model working again, which forget a provider-retry note. Session,
 *  usage and cost metadata do not (hearsay-tools/squawk#3337). */
const MODEL_PROGRESS: ReadonlySet<AgentEvent['type']> = new Set(['text', 'tool-call', 'tool-result', 'image']);

/** True for top-level model work in the v2 stream: a non-hook item outside a nested agent starts,
 *  or a delta reaches one. `open` holds those items until they or their turn complete. A delta
 *  carries no parent, so a nested or hook item's delta is not work here. */
export function topLevelModelWork(open: Set<string>, event: UiEvent): boolean {
  switch (event.type) {
    case 'item.started':
      if (event.item.kind === 'hook' || event.item.parentItemId !== undefined) return false;
      if (event.item.kind === 'message' && event.item.role === 'user') return false;
      open.add(event.item.id);
      return true;
    case 'item.delta': return open.has(event.itemId);
    case 'item.completed': open.delete(event.item.id); return false;
    case 'turn.completed': open.clear(); return false;
    default: return false;
  }
}

/** Wall-clock limits and open-turn liveness are independent. Native stream
 * activity refreshes this guard even when a mapper/coalescer emits no UI event.
 * Turn boundaries and human questions park it; starting/answering a turn rearms it.
 * Standalone runner users retain their existing deadline policy. */
export function startManagedSession(
  runner: Pick<AgentRunner, 'startSession'>,
  spec: AgentRunSpec,
  onEvent: (event: AgentEvent) => void,
  opts: SessionOptions,
): AgentSession {
  const noProgressTimeoutMs = spec.timings?.noProgressTimeoutMs ?? DEFAULT_RUNNER_TIMINGS.noProgressTimeoutMs;
  let session: AgentSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let turnOpen = true;
  let stopped = false;
  let phase = 0;
  const pendingPermissions = new Set<string>();
  // The runner's last provider-retry note in this turn (hearsay-tools/squawk#3337): a kill during
  // the provider's own retries names it, so the run holds on the provider error instead of failing.
  let providerNote: string | undefined;
  const openItems = new Set<string>();
  const pause = (): void => {
    phase += 1;
    turnOpen = false;
    clearTimeout(timer);
    timer = undefined;
  };
  const stop = (): void => { stopped = true; pause(); };
  const activity = (): void => {
    if (stopped || !turnOpen) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      stop();
      const failing = providerNote ? `; the provider was failing: ${providerNote}` : '';
      onEvent({ type: 'error', message: `Agent made no progress for ${noProgressTimeoutMs / 60_000} minutes during an open turn and was terminated${failing}` });
      session?.interrupt();
    }, noProgressTimeoutMs);
    timer.unref?.();
  };
  const begin = (): void => { if (!stopped && !pendingPermissions.size) { phase += 1; turnOpen = true; activity(); } };
  // Includes a backend that accepts the opening prompt but never announces a turn.
  begin();
  try {
    session = runner.startSession(spec, event => {
      if (event.type === 'note') providerNote = classifyProviderError(event.message) ? event.message : providerNote;
      else if (MODEL_PROGRESS.has(event.type)) providerNote = undefined;
      if (event.type === 'turn-end') pause();
      if (event.type === 'error' || event.type === 'done') stop();
      onEvent(event);
    }, {
      ...opts,
      onActivity: () => { activity(); opts.onActivity?.(); },
      onUiEvent: event => {
        if (event.type === 'turn.started') begin();
        if (topLevelModelWork(openItems, event)) providerNote = undefined;
        // oxlint-disable-next-line cez/ask-requested-read-outside-projection -- Pause the transport on the event type; no payload is read.
        if (event.type === 'ask.requested') pause();
        if (event.type === 'permission.requested') { pendingPermissions.add(event.requestId); pause(); }
        if (event.type === 'permission.resolved' && pendingPermissions.delete(event.requestId) && !pendingPermissions.size) begin();
        opts.onUiEvent?.(event);
      },
    });
  } catch (error) { stop(); throw error; }
  const live = session;
  const result = live.result.then(value => { stop(); return value; }, error => { stop(); throw error; });
  return {
    result,
    get pid() { return live.pid; },
    get open() { return live.open; },
    get closingQuietly() { return live.closingQuietly === true; },
    sendMessage(content) {
      if (pendingPermissions.size) return false;
      const wasOpen = turnOpen;
      if (!wasOpen) begin(); // Native question answers resume the same turn ID.
      const accepted = live.sendMessage(content);
      if (!accepted && !wasOpen) pause();
      return accepted;
    },
    sendAgentMessage(content, ids) {
      if (pendingPermissions.size) return false;
      const wasOpen = turnOpen;
      if (!wasOpen) begin();
      const admissionPhase = phase;
      const rollback = (): void => { if (!wasOpen && phase === admissionPhase) pause(); };
      try {
        const accepted = live.sendAgentMessage(content, ids);
        if (accepted === false) { rollback(); return false; }
        // Do not rearm after an ACK: a synchronous turn-end or ask may already
        // have parked the session. Only a refused reservation rolls back.
        return accepted.catch(error => { rollback(); throw error; });
      } catch (error) { rollback(); throw error; }
    },
    ...(live.respondPermission ? { respondPermission: (requestId: string, optionId: string) => live.respondPermission!(requestId, optionId) } : {}),
    discardQueuedMessages: () => live.discardQueuedMessages(),
    holdsHumanInput: () => live.holdsHumanInput(),
    ...(live.heldHumanInputCount ? { heldHumanInputCount: () => live.heldHumanInputCount!() } : {}),
    end: () => { stop(); live.end(); },
    // The guard stays armed: a turn the late request reopens is still an open turn.
    ...(live.endWhenQuiet ? { endWhenQuiet: () => live.endWhenQuiet!() } : {}),
    interrupt: () => { stop(); live.interrupt(); },
  };
}
