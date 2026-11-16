import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import type { AgentEvent, AgentSession } from './agent-runner.ts';
import { SessionEndedBeforeAcknowledgement } from './agent-runner.ts';
import { waitFor } from './harness-parity-core.testkit.ts';
import { observationClock } from './observation-clock.testkit.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { UNSET_TOOL_GRANT } from './tool-grant.testkit.ts';
import type { UiEvent } from './ui-events.ts';

const bin = fileURLToPath(new URL('../../scripts/mock-opencode-serve.mjs', import.meta.url));
const owned: { dir: string; session: AgentSession }[] = [];
afterEach(async () => {
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

it('keeps a dropped command alive beyond 300 seconds, then completes from SSE', async () => {
  const { dir, session, events } = start();
  await waitFor(() => ends(events) === 1);
  const gate = join(dir, 'release');
  // Fake the parent deadline clock; the child waits on a file, so no wall-clock race decides completion.
  const clock = observationClock(delay => delay !== undefined && delay >= 300_000);
  const ack = session.sendAgentMessage(skill(`mock:skill-drop mock:skill-gated ${gate}`), ['skill-input']);
  expect(ack).not.toBe(false);
  await ack;
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
