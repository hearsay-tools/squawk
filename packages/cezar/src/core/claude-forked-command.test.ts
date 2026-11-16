/**
 * Typed forked Claude commands (hearsay-tools/squawk#1315): the golden `forked-command` fixture,
 * sanitized from a live CLI 2.1.321 capture, pins the whole sequence; these cases pin each branch.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { z } from 'zod';

import type { UiEvent } from './ui-events.ts';
import { claudeTurnStarted, createClaudeUiState, mapClaudeMessage, type ClaudeUiMapperState } from './claude-ui-mapper.ts';
import { STATUS_MAP as CODEX_TOOL_STATUS_MAP } from './codex-ui-mapper.ts';
import { STATUS_MAP as OPENCODE_TOOL_STATUS_MAP } from './opencode-ui-mapper.ts';

const TOOL_STATUS = z.enum([...Object.values(OPENCODE_TOOL_STATUS_MAP), ...Object.values(CODEX_TOOL_STATUS_MAP)]).enum;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'claude', 'forked-command.ndjson');
const FORK_ID = 'forked-command-fxfork';

const fixtureLines = (): Array<Record<string, unknown>> =>
  readFileSync(FIXTURE, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>);

const itemsOf = (events: readonly UiEvent[]): Array<Record<string, unknown>> =>
  events.flatMap((event) => ('item' in event ? [event.item as unknown as Record<string, unknown>] : []));

function runTurn(lines: readonly unknown[], state: ClaudeUiMapperState = createClaudeUiState()): { events: UiEvent[]; state: ClaudeUiMapperState } {
  const started = claudeTurnStarted(state);
  const events: UiEvent[] = [...started.events];
  let next = started.state;
  for (const line of lines) {
    const mapped = mapClaudeMessage(line, next);
    next = mapped.state;
    events.push(...mapped.events);
  }
  return { events, state: next };
}

describe('claude typed forked command', () => {
  it('nests every child of the fork under one parent-less task item in the same turn', () => {
    const items = itemsOf(runTurn(fixtureLines()).events);
    const children = items.filter((item) => item.parentItemId !== undefined);
    expect(children.length).toBeGreaterThan(0);
    expect(new Set(children.map((item) => item.parentItemId))).toEqual(new Set([FORK_ID]));
    const roots = items.filter((item) => item.id === FORK_ID);
    expect(roots.every((item) => item.toolKind === 'task' && item.parentItemId === undefined && item.title === '/fxfork')).toBe(true);
    expect(roots.map((item) => item.status)).toEqual([TOOL_STATUS.running, TOOL_STATUS.completed]);
  });

  it('gives the same command typed in a later turn its own fork item', () => {
    const first = runTurn(fixtureLines());
    const second = runTurn(fixtureLines().filter((line) => line.subtype !== 'init'), first.state);
    const items = itemsOf(second.events);
    expect(new Set(items.filter((item) => item.toolKind === 'task').map((item) => item.id))).toEqual(new Set([`${FORK_ID}-2`]));
    const children = items.filter((item) => item.parentItemId !== undefined);
    expect(new Set(children.map((item) => item.parentItemId))).toEqual(new Set([`${FORK_ID}-2`]));
  });

  it('never gives a repeated command the id of another command named like its suffix', () => {
    const rename = (lines: Array<Record<string, unknown>>, wireId: string) =>
      lines.filter((line) => line.subtype !== 'init').map((line) => (line.parent_tool_use_id === FORK_ID ? { ...line, parent_tool_use_id: wireId } : line));
    let state = runTurn(fixtureLines()).state;
    const forkIds: unknown[] = [];
    for (const wireId of [FORK_ID, `${FORK_ID}-2`, `${FORK_ID}-2`]) {
      const turn = runTurn(rename(fixtureLines(), wireId), state);
      state = turn.state;
      forkIds.push(itemsOf(turn.events).find((item) => item.toolKind === 'task')?.id);
    }
    expect(forkIds).toEqual([`${FORK_ID}-2`, `${FORK_ID}-2-2`, `${FORK_ID}-2-3`]);
  });

  it('titles the fork from the command name when its task_started was not seen', () => {
    const lines = fixtureLines().filter((line) => line.subtype !== 'task_started');
    const fork = itemsOf(runTurn(lines).events).find((item) => item.toolKind === 'task');
    expect(fork).toEqual({ kind: 'tool', id: FORK_ID, name: 'Skill', toolKind: 'task', title: '/fxfork', status: TOOL_STATUS.running });
  });

  it.each(['error_during_execution', 'error_max_turns'])('fails the fork when its turn ends with %s', (subtype) => {
    const lines = fixtureLines().map((line) => (line.type === 'result' ? { ...line, subtype, is_error: true } : line));
    const completed = runTurn(lines).events.filter((event) => event.type === 'item.completed');
    expect(itemsOf(completed).find((item) => item.toolKind === 'task')?.status).toBe(TOOL_STATUS.failed);
  });

  it('leaves a child whose parent is an ordinary tool id unchanged', () => {
    const child = { type: 'assistant', parent_tool_use_id: 'toolu_task_01', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } };
    expect(itemsOf(mapClaudeMessage(child, createClaudeUiState()).events).map((item) => item.parentItemId)).toEqual(['toolu_task_01', 'toolu_task_01']);
  });
});
