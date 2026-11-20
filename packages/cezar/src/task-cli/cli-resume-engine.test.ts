import { describe, expect, it, vi } from 'vitest';
import { createRunManager } from '../server/engine-run-manager.testkit.ts';
import { taskCliFixture } from './cli.testkit.ts';

// `send --resume` reports `resumed` only once the engine accepts the Continue, which the fake does not
// do (hearsay-tools/squawk#3937). Moved from cli-actions.test.ts and cli-results.test.ts.
describe('cez task send --resume', () => {
  const ctx = taskCliFixture(createRunManager);
  const { run, last, start, withWebhook } = ctx;

  it('reopens a closed session with --resume', async () => {
    const id = await start();
    ctx.manager.cancel(id);
    expect(await run(['send', id, 'go on', '--resume'])).toBe(0);
    expect(last()).toMatchObject({ id, delivery: 'resumed' });
  });

  it('sends the continuation text and omits a notification message', async () => {
    await withWebhook();
    const id = await start();
    ctx.manager.cancel(id);
    const spy = vi.spyOn(globalThis, 'fetch');
    try {
      expect(await run(['send', id, 'continue text', '--resume', '--notify'])).toBe(0);
      expect(last()).toEqual({ id, delivery: 'resumed', notify: true });
      const posts = spy.mock.calls.filter(([, init]) => init?.method === 'POST')
        .map(([url, init]) => ({ url: String(url), body: JSON.parse(init!.body as string) as unknown }));
      expect(posts).toEqual([
        { url: `${ctx.cockpit.api}/runs/${id}/notify`, body: { notify: true } },
        { url: `${ctx.cockpit.api}/runs/${id}/messages`, body: { text: 'continue text' } },
        { url: `${ctx.cockpit.api}/runs/${id}/continue`, body: { text: 'continue text' } },
      ]);
    } finally { spy.mockRestore(); }
  });
});
