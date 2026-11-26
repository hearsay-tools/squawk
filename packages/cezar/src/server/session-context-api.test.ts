import '../built-in-wait-kinds.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContextFile, SessionContextPreview } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

const VALID = 'version: 1\nrules:\n  - id: brief\n    on: session_start\n    template: Read docs/vision.md.\n';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * `GET/PUT /session-context` and `POST /session-context/preview` (hearsay-tools/squawk#4308): the
 * cockpit edits the same `context.yaml` a launch reads, never over a newer disk version, never with
 * problems, never in read-only fallback data, and on a remote cockpit without `settingsAdmin` too.
 */
describe('the session-context API', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const prevRemote = process.env.CEZ_REMOTE;

  /** `legacy` keeps project data in `.ai/cezar/`; `fresh` starts it in `.ai/squawk/`. */
  function boot(layout: 'legacy' | 'fresh') {
    const data = join(repoRoot, layout === 'legacy' ? '.ai/cezar' : '.ai/squawk');
    mkdirSync(data, { recursive: true });
    store = RunStore.open(data);
    app = createApp({ home: testHome(), repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', squawkPort: () => 4321 });
  }

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-session-context-api-'));
  });
  afterEach(() => {
    store.persistence.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (prevRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = prevRemote;
  });

  const get = async () => (await (await apiRequest(app, '/api/v1/session-context')).json()) as SessionContextFile;
  const put = (body: unknown) =>
    apiRequest(app, '/api/v1/session-context', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const preview = (body: unknown) =>
    apiRequest(app, '/api/v1/session-context/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('reads a missing file as empty and creates it in the legacy project directory', async () => {
    boot('legacy');
    expect(await get()).toEqual({ path: '.ai/cezar/context.yaml', exists: false, content: '', version: null, writable: true, readOnlyReason: null });
    const res = await put({ content: VALID, version: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: '.ai/cezar/context.yaml', exists: true, content: VALID, version: sha(VALID), writable: true, readOnlyReason: null });
    expect(readFileSync(join(repoRoot, '.ai/cezar/context.yaml'), 'utf8')).toBe(VALID);
  });

  it('reads and writes .ai/squawk/context.yaml in a project that starts there', async () => {
    boot('fresh');
    writeFileSync(join(repoRoot, '.ai/squawk/context.yaml'), 'version: 1\n');
    expect(await get()).toMatchObject({ path: '.ai/squawk/context.yaml', exists: true, content: 'version: 1\n', version: sha('version: 1\n') });
    expect((await put({ content: VALID, version: sha('version: 1\n') })).status).toBe(200);
    expect(readFileSync(join(repoRoot, '.ai/squawk/context.yaml'), 'utf8')).toBe(VALID);
    expect(existsSync(join(repoRoot, '.ai/cezar/context.yaml'))).toBe(false);
  });

  it('refuses a save over a newer disk version and leaves the file as it is', async () => {
    boot('legacy');
    writeFileSync(join(repoRoot, '.ai/cezar/context.yaml'), 'version: 1\n# edited elsewhere\n');
    const res = await put({ content: VALID, version: sha('version: 1\n') });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('changed on disk');
    expect(readFileSync(join(repoRoot, '.ai/cezar/context.yaml'), 'utf8')).toBe('version: 1\n# edited elsewhere\n');
    // Overwrite: the editor sends the version it now read.
    expect((await put({ content: VALID, version: sha('version: 1\n# edited elsewhere\n') })).status).toBe(200);
  });

  it('refuses text with problems and names the first one', async () => {
    boot('legacy');
    writeFileSync(join(repoRoot, '.ai/cezar/context.yaml'), VALID);
    const res = await put({ content: VALID.replace('brief', 'handoff'), version: sha(VALID) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'context.yaml has problems; fix them to save (line 3: id "handoff" is reserved for the built-in handoff block)',
    );
    expect(readFileSync(join(repoRoot, '.ai/cezar/context.yaml'), 'utf8')).toBe(VALID);
  });

  it('keeps a fallback copy read only', async () => {
    boot('legacy');
    mkdirSync(join(repoRoot, '.ai/squawk'));
    writeFileSync(join(repoRoot, '.ai/squawk/context.yaml'), VALID);
    const read = await get();
    expect(read).toMatchObject({ path: '.ai/squawk/context.yaml', content: VALID, writable: false });
    expect(read.readOnlyReason).toContain('read-only project data');
    expect((await put({ content: 'version: 1\n', version: sha(VALID) })).status).toBe(409);
    expect(readFileSync(join(repoRoot, '.ai/squawk/context.yaml'), 'utf8')).toBe(VALID);
  });

  it('never offers to overwrite a file it cannot read as text', async () => {
    boot('legacy');
    const bytes = Buffer.from([0xff, 0xfe, 0x00]);
    writeFileSync(join(repoRoot, '.ai/cezar/context.yaml'), bytes);
    expect(await get()).toMatchObject({ exists: true, content: '', version: null, writable: false, readOnlyReason: expect.stringContaining('not valid UTF-8') });
    expect((await put({ content: VALID, version: null })).status).toBe(409);
    expect(readFileSync(join(repoRoot, '.ai/cezar/context.yaml'))).toEqual(bytes);
  });

  it('previews a draft for a role without writing it', async () => {
    boot('legacy');
    const res = await preview({ content: VALID, role: 'worker' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionContextPreview;
    expect(body.problems).toEqual([]);
    expect(body.blocks.map((b) => [b.id, b.status])).toEqual([['handoff', 'applied'], ['brief', 'applied']]);
    expect(body.limitBytes).toBe(65_536);
    expect(existsSync(join(repoRoot, '.ai/cezar/context.yaml'))).toBe(false);
    expect((await preview({ content: VALID, role: 'everyone' })).status).toBe(400);
  });

  it('lets a remote cockpit without settings administration save', async () => {
    boot('legacy');
    process.env.CEZ_REMOTE = '1';
    const health = (await (await apiRequest(app, '/api/v1/health')).json()) as { capabilities: { settingsAdmin: boolean } };
    expect(health.capabilities.settingsAdmin).toBe(false);
    expect((await put({ content: VALID, version: null })).status).toBe(200);
  });
});
