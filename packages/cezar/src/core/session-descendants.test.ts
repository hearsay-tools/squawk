import { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionDescendants } from './session-descendants.ts';

const state = vi.hoisted(() => ({ leaderState: 'S', threads: 1, boot: 'boot-one', tokens: new Map<number, string | undefined>(), alive: new Set<number>() }));
vi.mock('./process-stat.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./process-stat.ts')>(),
  linuxBootId: () => state.boot,
  processStartToken: (pid: number) => state.tokens.get(pid),
  pidExists: (pid: number) => state.alive.has(pid),
}));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readdirSync: () => ['100', '200'],
  readFileSync: (path: string) => {
    const pid = Number(path.split('/')[2]);
    const token = state.tokens.get(pid);
    if (!token || !state.alive.has(pid)) throw new Error('Process gone');
    const fields = Array(20).fill('0');
    fields[0] = pid === 200 ? state.leaderState : 'S'; fields[1] = String(pid === 200 ? 100 : 1);
    fields[17] = String(state.threads); fields[19] = token.split(':').at(-1)!;
    return `${pid} (fixture) ${fields.join(' ')}`;
  },
}));
beforeEach(() => {
  vi.useFakeTimers(); state.leaderState = 'S'; state.threads = 1; state.boot = 'boot-one';
  state.tokens = new Map([[100, 'boot-one:10'], [200, 'boot-one:20']]);
  state.alive = new Set([100, 200]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function descendants() {
  const child = new ChildProcess(); Object.defineProperty(child, 'pid', { value: 100 });
  return new SessionDescendants(child);
}

it.runIf(process.platform === 'linux')('kills an observed detached child after leader exit when its full identity still matches', () => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const scope = descendants(); scope.capture();
  state.alive.delete(100); scope.terminate(50);
  expect(kill).toHaveBeenCalledWith(200, 'SIGTERM');
  vi.advanceTimersByTime(50);
  expect(kill).toHaveBeenCalledWith(200, 'SIGKILL');
});

it.runIf(process.platform === 'linux').each(['boot-two:20', 'boot-one:21', undefined])('skips the delayed kill when the observed identity becomes %s', token => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const scope = descendants(); scope.capture(); scope.terminate(50);
  expect(kill).toHaveBeenCalledWith(200, 'SIGTERM'); kill.mockClear();
  state.alive.delete(100); state.tokens.set(200, token);
  vi.advanceTimersByTime(50);
  expect(kill).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'linux').each([1, 2])('reaps a zombie leader only while its thread group has live threads (threads=%s)', threads => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  state.leaderState = 'Z'; state.threads = threads;
  const scope = descendants(); scope.capture(); scope.signal('SIGTERM');
  expect(kill.mock.calls).toEqual(threads > 1 ? [[200, 'SIGTERM']] : []);
});
