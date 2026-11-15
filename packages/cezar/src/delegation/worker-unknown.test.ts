import { afterEach, expect, it, vi } from 'vitest';
import { runWorkerCommand } from './cli.ts';
afterEach(() => vi.restoreAllMocks());
it.each(['send', 'progress', 'follow-up', 'reply', 'conversation', 'inbox', 'cancel-request', 'wait-requests', 'tasks', 'not-a-command'])('rejects unsupported worker verb %s without transport', async verb => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const fetch = vi.spyOn(globalThis, 'fetch');
  expect(await runWorkerCommand([verb], {})).toBe(1);
  expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual({ code: 'invalid_input', error: `unknown operation '${verb}'` });
  expect(fetch).not.toHaveBeenCalled();
});
