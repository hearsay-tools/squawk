import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS, makeRunRecord } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunStatus } from '@open-mercato/cezar-contract';
import { testHome } from './home/test-home.testkit.ts';
import { main } from './cli-dispatch.ts';
import { serveCommand } from './serve-command.ts';
import { runHeadless } from './headless-run.ts';
import { RUNS_IMPORT_COMPLETE_KEY, RunDatabase } from './runs/run-database.ts';
import { encodeRunRow } from './runs/run-row.ts';
import { loadWorkflows } from './workflows/load.ts';
import { discoverSkills } from './skills.ts';
import { projectPaths } from './project-paths.ts';
import { MIGRATION_JOURNAL_FILE, ProjectMigrationFencedError } from './project-fence.ts';
import type { Cockpit } from './task-cli/http.ts';

vi.mock('./cli-dispatch.ts', () => ({ defaultCliDeps: {}, main: vi.fn(async () => undefined) }));
vi.mock('./serve-command.ts', () => ({ defaultServeDeps: {}, serveCommand: vi.fn(async () => undefined) }));
vi.mock('./headless-run.ts', () => ({ defaultHeadlessDeps: {}, runHeadless: vi.fn(async () => undefined) }));
vi.mock('./runs/arm-repo-handle.ts', () => ({ armRepoHandle: vi.fn() }));
// The real hint, with cockpit discovery the test answers and stderr it reads.
const hint = vi.hoisted(() => ({ discovering: [] as Array<(cockpit: Cockpit) => void>, lines: [] as string[] }));
vi.mock('./task-cli/hint.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-cli/hint.ts')>();
  return {
    startCockpitHint: (repoDir: string) => actual.startCockpitHint(repoDir, {
      discover: () => new Promise<Cockpit>(resolve => { hint.discovering.push(resolve); }),
      write: line => { hint.lines.push(line); },
    }),
  };
});
// Loaded before index.ts so its lazy import of the hint resolves to the module above.
await import('./task-cli/hint.ts');
await import('./index.ts');
const cli = vi.mocked(main).mock.calls[0]![0];

describe('CLI project paths at real entry points', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cli-project-paths-'));
    mkdirSync(join(repo, '.ai/cezar'), { recursive: true }); // Exercise legacy precedence and Squawk fallback.
  });
  afterEach(() => { vi.restoreAllMocks(); vi.mocked(serveCommand).mockReset(); vi.mocked(runHeadless).mockReset(); rmSync(repo, { recursive: true, force: true }); });
  function seedFallback(status: RunStatus = RUN_STATUS.done) {
    const directory = join(repo, '.ai/squawk');
    mkdirSync(directory, { recursive: true });
    const record = makeRunRecord({ id: randomUUID(), task: 'fallback', title: 'fallback', workflow: 'quick-task',
      status, createdAt: '2026-11-01T00:00:00Z', steps: [] });
    const db = RunDatabase.open(join(directory, 'runs.db'));
    db.transaction({ upserts: [encodeRunRow(record)], deletes: [], meta: { [RUNS_IMPORT_COMPLETE_KEY]: 'fixture' } });
    db.close();
    return record;
  }

  it('initializes examples under legacy and keeps authored files intact on repeated init', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mkdirSync(join(repo, '.ai/squawk/workflows'), { recursive: true });
    writeFileSync(join(repo, '.ai/squawk/workflows/custom.yaml'), 'fallback workflow');
    await cli.initCommand(repo);
    const example = join(repo, '.ai/cezar/workflows/fix-and-verify.yaml');
    expect(existsSync(example)).toBe(true);
    expect(existsSync(join(repo, '.ai/cezar/skills/project-conventions.md'))).toBe(true);
    writeFileSync(example, 'authored workflow');
    await cli.initCommand(repo);
    expect(readFileSync(example, 'utf8')).toBe('authored workflow');
    expect(readFileSync(join(repo, '.ai/squawk/workflows/custom.yaml'), 'utf8')).toBe('fallback workflow');
    expect(log).toHaveBeenCalled();
  });

  it('skips a starter whose name an authored .ai/squawk/ workflow or skill already uses', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mkdirSync(join(repo, '.ai/squawk/workflows'), { recursive: true });
    mkdirSync(join(repo, '.ai/squawk/skills'), { recursive: true });
    writeFileSync(join(repo, '.ai/squawk/workflows/mine.yaml'), 'name: fix-and-verify\nskills: [implement]\n');
    writeFileSync(join(repo, '.ai/squawk/skills/conventions.md'), '---\nname: project-conventions\n---\n\n# Mine\n');
    await cli.initCommand(repo);
    expect(existsSync(join(repo, '.ai/cezar/workflows/fix-and-verify.yaml'))).toBe(false);
    expect(existsSync(join(repo, '.ai/cezar/skills/project-conventions.md'))).toBe(false);
    const { workflows } = await loadWorkflows(repo);
    expect(workflows.find(workflow => workflow.name === 'fix-and-verify')?.path).toBe(join(repo, '.ai/squawk/workflows/mine.yaml'));
    expect((await discoverSkills(repo, { builtin: [] }, testHome())).find(skill => skill.name === 'project-conventions')?.path)
      .toBe(join(repo, '.ai/squawk/skills/conventions.md'));
  });

  it('serves fallback history without creating an empty legacy runs database', async () => {
    const run = seedFallback();
    vi.mocked(serveCommand).mockImplementation(async (_home, root, _port, _open, _host, _restart, deps) => {
      const store = deps.openBootStore(root);
      try { expect(store.getRun(run.id)?.title).toBe('fallback'); }
      finally { store.close(); }
    });
    await cli.serveCommand(testHome(), repo, 4321, false, undefined, false);
    expect(existsSync(join(repo, '.ai/cezar/runs.db'))).toBe(false);
  });

  it('keeps a running task live in the boot store, so the cockpit can resume it', async () => {
    const run = seedFallback(RUN_STATUS.running);
    let status: string | undefined;
    vi.mocked(serveCommand).mockImplementation(async (_home, root, _port, _open, _host, _restart, deps) => {
      const store = deps.openBootStore(root);
      try { status = store.getRun(run.id)?.status; }
      finally { store.close(); }
    });
    await cli.serveCommand(testHome(), repo, 4321, false, undefined, false);
    expect(status).toBe(RUN_STATUS.running);
  });

  it('serves a boot project whose run history is damaged as unavailable and names the cause', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeFileSync(join(projectPaths(repo).write, 'runs.db'), 'not a database');
    let unavailable: string | undefined;
    vi.mocked(serveCommand).mockImplementation(async (_home, root, _port, _open, _host, _restart, deps) => {
      unavailable = deps.openBootStore(root).unavailable?.message;
    });
    await cli.serveCommand(testHome(), repo, 4321, false, undefined, false);
    expect(unavailable).toContain('is damaged');
    expect(error).toHaveBeenCalledExactlyOnceWith(`\n  ✗ ${unavailable}\n`);
  });

  it('refuses to serve a boot project that an unfinished migration blocks', async () => {
    writeFileSync(join(repo, '.ai', MIGRATION_JOURNAL_FILE), '{}');
    vi.mocked(serveCommand).mockImplementation(async (_home, root, _port, _open, _host, _restart, deps) => { deps.openBootStore(root); });
    await expect(cli.serveCommand(testHome(), repo, 4321, false, undefined, false)).rejects.toBeInstanceOf(ProjectMigrationFencedError);
  });

  it('opens fallback history through the headless entry without shadowing it', async () => {
    const run = seedFallback();
    let title: string | undefined;
    vi.mocked(runHeadless).mockImplementation(async (_home, root, _task, _workflow, _model, _access, deps) => {
      const store = deps.openStore(root, { repoHandleSignal: new AbortController().signal });
      try { title = store.getRun(run.id)?.title; }
      finally { store.close(); }
    });
    await cli.runCommand(testHome(), repo, 'task', undefined, undefined, { allowWorkers: true, allowMessaging: true });
    expect(title).toBe('fallback');
    expect(existsSync(join(repo, '.ai/cezar/runs.db'))).toBe(false);
  });

  it('prints usage and fails a run without a task, without starting one', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitCode = process.exitCode;
    try {
      await cli.runCommand(testHome(), repo, '', undefined, undefined, { allowWorkers: true, allowMessaging: true });
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = exitCode; }
    expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('run "<task>"'));
    expect(runHeadless).not.toHaveBeenCalled();
  });

  it('prints a running cockpit found during a headless run, and nothing once the run has ended', async () => {
    const cockpit = (port: number): Cockpit => ({ origin: `http://127.0.0.1:${port}`, projectId: 'p', api: `http://127.0.0.1:${port}/api/v1/p/p` });
    const settle = () => new Promise(resolve => setImmediate(resolve));
    const access = { allowWorkers: true, allowMessaging: true };
    hint.lines.length = 0;
    vi.mocked(runHeadless).mockImplementation(async () => {
      await vi.waitFor(() => expect(hint.discovering).toHaveLength(1));
      hint.discovering[0]!(cockpit(4321));
      await settle();
    });
    await cli.runCommand(testHome(), repo, 'task', undefined, undefined, access);
    expect(hint.lines).toEqual([expect.stringContaining('a cockpit is running at http://127.0.0.1:4321')]);
    vi.mocked(runHeadless).mockImplementation(async () => { await vi.waitFor(() => expect(hint.discovering).toHaveLength(2)); });
    await cli.runCommand(testHome(), repo, 'task', undefined, undefined, access);
    hint.discovering[1]!(cockpit(4322));
    await settle();
    expect(hint.lines).toHaveLength(1);
  });
});
