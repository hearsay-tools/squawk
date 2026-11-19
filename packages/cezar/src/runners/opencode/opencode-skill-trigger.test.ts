import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession } from '../../core/agent-runner.ts';
import { SessionEndedBeforeAcknowledgement } from '../../core/agent-runner.ts';
import { waitFor } from '../../core/harness-parity-core.testkit.ts';
import { observationClock } from '../../core/observation-clock.testkit.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { registerRunner } from '../../core/runner-registry.ts';
import { opencodeRunner } from './definition.ts';

// The runner's session env reads opencode's registry data; this test drives only opencode.
registerRunner(opencodeRunner);
import { UNSET_TOOL_GRANT } from '../../core/tool-grant.testkit.ts';
import type { UiEvent } from '../../core/ui-events.ts';

const bin = fileURLToPath(new URL('../../../scripts/mock-opencode-serve.mjs', import.meta.url));
const owned: { dir: string; session: AgentSession }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { dir, session } of owned.splice(0)) {
    session.end();
    await session.result.catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
function start() {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-skill-'));
  const events: AgentEvent[] = [];
  const ui: UiEvent[] = [];
  const session = new OpencodeServerRunner({ bin, timeoutMs: 0 }).startSession(
    { cwd: dir, toolGrant: UNSET_TOOL_GRANT, userPrompt: 'inspect the tree' },
    event => events.push(event), { onUiEvent: event => ui.push(event) },
  );
  owned.push({ dir, session });
  return { dir, session, events, ui };
}
const ends = (events: AgentEvent[]) => events.filter(event => event.type === 'turn-end').length;
const skill = (args: string, id = 'probe-project') => [{ type: 'skill' as const, id, args }];

it.each(['drop', 'headers-timeout'] as const)('keeps a command alive after %s and beyond 300 seconds, then completes from SSE', async mode => {
  const { dir, session, events } = start();
  await waitFor(() => ends(events) === 1);
  const gate = join(dir, 'release');
  // Fake the parent deadline clock; the child waits on a file, so no wall-clock race decides completion.
  const clock = observationClock(delay => delay !== undefined && delay >= 300_000);
  if (mode === 'headers-timeout') {
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (!String(input).endsWith('/command')) return nativeFetch(input, init);
      // Model fetch's 300 s header deadline while the real native command/SSE stay gated.
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new Error('mock fetch headers timeout')), 300_000);
      const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
      return nativeFetch(input, { ...init, signal }).finally(() => clearTimeout(timer));
    });
  }
  const ack = session.sendAgentMessage(skill(`${mode === 'drop' ? 'mock:skill-drop ' : ''}mock:skill-gated ${gate}`), ['skill-input']);
  expect(ack).not.toBe(false);
  await ack;
  if (mode === 'headers-timeout') expect(clock.captured).toBeGreaterThan(0);
  await clock.advance(301_000);
  expect(ends(events)).toBe(1);
  expect(events.filter(event => event.type === 'error')).toEqual([]);
  writeFileSync(gate, '');
  await waitFor(() => ends(events) === 2);
  expect(events.some(event => event.type === 'text' && event.text.includes('TRIGGER-FIXTURE'))).toBe(true);
});

it.each(['end', 'interrupt', 'exit'] as const)('rejects an unacknowledged skill on %s and settles the session', async action => {
  const { session, events } = start();
  await waitFor(() => ends(events) === 1);
  const ack = session.sendAgentMessage(skill('mock:skill-no-ack'));
  expect(ack).not.toBe(false);
  const rejected = expect(ack).rejects.toBeInstanceOf(SessionEndedBeforeAcknowledgement);
  if (action === 'exit') process.kill(session.pid!, 'SIGKILL');
  else session[action]();
  await rejected;
  await session.result;
});

it.each(['http', 'sse'] as const)('fails an agent skill on a %s error before acknowledgement', async transport => {
  const { session, events, ui } = start();
  await waitFor(() => ends(events) === 1);
  const ack = session.sendAgentMessage(skill(transport === 'http' ? 'mock:http-error-only' : 'mock:skill-sse-error', transport === 'http' ? 'probe-missing' : 'probe-project'));
  expect(ack).not.toBe(false);
  await expect(ack).rejects.toThrow();
  await waitFor(() => ends(events) === 2);
  expect(events.filter(event => event.type === 'error')).toHaveLength(1);
  expect(ui.some(event => event.type === 'session.error')).toBe(true);
  expect(ui.filter(event => event.type === 'turn.completed')).toHaveLength(2);
  expect(ui.at(-1)).toMatchObject({ type: 'turn.completed', stopReason: 'error' });
});
