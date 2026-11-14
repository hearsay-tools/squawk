import { expect, it, vi } from 'vitest';
import { useHostFixture, flush } from './host.testkit.ts';
import { fakeViewer } from './preview.testkit.ts';
import { PreviewSession } from './session.ts';

const make = useHostFixture();

it('passes the open ratio to both a new session and the session reused on reload', async () => {
  const { host, ctx, answering } = make();
  answering.add(5173);
  const attach = vi.spyOn(PreviewSession.prototype, 'attach');
  try {
    const first = fakeViewer();
    await host.handle(ctx, first, { t: 'open', target: { port: 5173 }, quality: 'ultra', dpr: 2 });
    await flush();
    expect(attach).toHaveBeenLastCalledWith(first, 2);
    host.detach(ctx.runId, first);
    attach.mockClear();
    const next = fakeViewer();
    await host.handle(ctx, next, { t: 'open', target: { port: 5173 }, quality: 'ultra', dpr: 1 });
    await flush();
    expect(attach.mock.calls.length).toBeGreaterThan(0);
    for (const call of attach.mock.calls) expect(call).toEqual([next, 1]);
  } finally {
    attach.mockRestore();
  }
});

it.each([1, 2, undefined])('same-viewer open with ratio %s restarts only for a changed ratio', async dpr => {
  const { host, ctx, answering, browsers } = make();
  answering.add(5173);
  const viewer = fakeViewer();
  await host.handle(ctx, viewer, { t: 'open', target: { port: 5173 }, quality: 'ultra', dpr: 2 });
  await flush();
  const browser = browsers[0]!;
  const before = browser.cdpFake.sent('Page.startScreencast').length;
  // A typed URL reuses the same page without reattaching the viewer.
  await host.handle(ctx, viewer, { t: 'open', target: { url: 'http://localhost:5173/next' }, quality: 'ultra', ...(dpr === undefined ? {} : { dpr }) });
  await flush();
  expect(browser.cdpFake.sent('Page.startScreencast')).toHaveLength(before + (dpr === 1 ? 1 : 0));
});

it.each([
  { opened: 1, resized: 2, attached: 2 },
  { opened: 2, resized: undefined, attached: 1 },
])('a browser restarted after the pane moved from ratio $opened to $resized attaches at $attached', async ({ opened, resized, attached }) => {
  const { host, ctx, answering, browsers } = make();
  answering.add(5173);
  const viewer = fakeViewer();
  await host.handle(ctx, viewer, { t: 'open', target: { port: 5173 }, quality: 'ultra', dpr: opened });
  await flush();
  // The pane omits the ratio at 1, as the cockpit sends it; other messages leave the ratio alone.
  await host.handle(ctx, viewer, { t: 'resize', w: 1280, h: 800, ...(resized === undefined ? {} : { dpr: resized }) });
  await host.handle(ctx, viewer, { t: 'ping', ts: 1 });
  browsers[0]!.exit({ stderrTail: 'crash' });
  await flush();
  const attach = vi.spyOn(PreviewSession.prototype, 'attach');
  try {
    await host.handle(ctx, viewer, { t: 'retryBrowser' });
    await flush();
    expect(browsers).toHaveLength(2);
    expect(attach.mock.calls).toEqual([[viewer, attached]]);
  } finally {
    attach.mockRestore();
  }
});
