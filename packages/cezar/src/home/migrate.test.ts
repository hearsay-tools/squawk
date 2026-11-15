import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home, homePaths, kindHomePaths } from './home.ts';
import { platformKindRoots } from './kind-roots.ts';
import { migrateLegacyHome, commitLegacyMigration, rollbackLegacyMigration } from './migrate.ts';
import { planLegacyMigration } from './migration-plan.ts';
import { readMigrationRecord } from './migration-record.ts';
import { createInstallMarker, readInstallMarker } from './install-marker.ts';
import * as installMarker from './install-marker.ts';
import { getHomeRecovery } from './recovery.ts';
import { HomeStore } from './store.ts';
import { holdCockpitLease } from './leases.ts';
import { VersionLog } from './version-log.ts';
import { migrationFixture, json, rawJson } from './migration.testkit.ts';
import { prepareOperatorHome } from './entry.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';
import { migrationFiles } from './migration-files.ts';
import * as privateFiles from './private-files.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it('D5: historical backup snapshots migrate as opaque bytes even when their JSON suffix hides malformed data', () => {
  const { legacy, target } = migrationFixture();
  const bytes = Buffer.from('malformed historical outside write\0\xff', 'latin1');
  const paths = ['backups/config.json/2026-11-07-badbytes.json', 'remote-settings/backups/4321.json/bad.json', 'server-instances/backups/one.json/bad.json'];
  for (const path of paths) {
    mkdirSync(join(legacy.root, path, '..'), { recursive: true });
    writeFileSync(join(legacy.root, path), bytes);
  }
  migrateLegacyHome(legacy, target);
  for (const path of ['config.json/2026-11-07-badbytes.json', 'remote-settings/4321.json/bad.json', 'server-instances/one.json/bad.json']) {
    expect(readFileSync(join(target.backups, path))).toEqual(bytes);
  }
});

it('B2: an accepted empty legacy registry keeps its exact acceptance and raises no target reset row', () => {
  const { legacy, target } = migrationFixture();
  Home.seed(legacy, `${legacy.workspaceConfig}.bak`, { projects: [{ id: 'kept', root: '/kept' }] });
  const store = new HomeStore(legacy);
  expect(store.recovery(legacy.workspaceConfig)?.reason).toBe('reset');
  store.acceptRecovery(legacy.workspaceConfig);
  const accepted = new VersionLog(legacy.root, 'config.json').record('ACCEPTED');
  expect(getHomeRecovery(legacy)).toEqual({ files: [] });
  migrateLegacyHome(legacy, target);
  expect(new VersionLog(target.config, 'config.json').record('ACCEPTED')).toEqual(accepted);
  expect(new VersionLog(target.config, 'config.json').record('RESET')).toBeUndefined();
  expect(new VersionLog(target.config, 'config.json').record('OUTSIDE')).toBeUndefined();
  expect(getHomeRecovery(target)).toEqual({ files: [] });
});

it('B2: a recopy clears target acceptance when the legacy acceptance no longer matches the copied bytes', () => {
  const { legacy, target } = migrationFixture();
  Home.seed(legacy, `${legacy.workspaceConfig}.bak`, { projects: [{ id: 'kept', root: '/kept' }] });
  const store = new HomeStore(legacy);
  store.recovery(legacy.workspaceConfig);
  store.acceptRecovery(legacy.workspaceConfig);
  migrateLegacyHome(legacy, target, { onStep(step, attempt) {
    if (step === 'recheck' && attempt === 0) rawJson(legacy.workspaceConfig, { projects: [], oldWriter: true });
  } });
  expect(new VersionLog(target.config, 'config.json').record('ACCEPTED')).toBeUndefined();
  expect(getHomeRecovery(target).files).toContainEqual(expect.objectContaining({ file: 'config.json', reason: 'reset' }));
});

it('B3: a reset interrupted after replacement but before HEAD advanced refuses migration under the claim', () => {
  const { legacy, target } = migrationFixture();
  Home.seed(legacy, legacy.agentAccounts, { accounts: [{ id: 'before-crash' }] });
  const setRecord = VersionLog.prototype.setRecord;
  vi.spyOn(VersionLog.prototype, 'setRecord').mockImplementation(function (this: VersionLog, name, record) {
    if (name === 'HEAD') throw new Error('crash before HEAD');
    setRecord.call(this, name, record);
  });
  expect(() => new HomeStore(legacy).writeJson(legacy.agentAccounts, { accounts: [] })).toThrow('crash before HEAD');
  vi.restoreAllMocks();
  const journal = join(legacy.root, '.versions/agent-accounts.json');
  const before = readdirSync(journal).map(name => [name, readFileSync(join(journal, name)).toString('base64')]);
  expect(() => migrateLegacyHome(legacy, target)).toThrow(/Resolve home recovery before migration: agent-accounts\.json \(reset\)/);
  expect(readdirSync(journal).map(name => [name, readFileSync(join(journal, name)).toString('base64')])).toEqual(before);
  expect(readInstallMarker(target.config)?.state).toBeUndefined();
  expect(getHomeRecovery(legacy).files).toContainEqual(expect.objectContaining({ file: 'agent-accounts.json', reason: 'reset', canRestore: true }));
});

it.each(['absent', 'empty'])('step 1: an %s legacy home commits a fresh decision with an empty inventory', kind => {
  const root = storeRoot(), old = join(root, 'legacy');
  if (kind === 'empty') mkdirSync(old);
  const legacy = homePaths(old, join(root, 'cache'), old);
  const target = Home.sandbox(join(root, 'new'), { layout: 'split' });
  expect(migrateLegacyHome(legacy, target).status).toBe('fresh');
  expect(readInstallMarker(target.config)).toMatchObject({ state: 'committed', migratedFrom: old });
  expect(readMigrationRecord(target)).toMatchObject({ files: [], backup: '', legacyRoot: old });
  expect(existsSync(join(legacy.root, '.migrating'))).toBe(false);
  if (kind === 'absent') expect(existsSync(old)).toBe(false);
  else expect(readdirSync(old).filter(name => name !== '.locks')).toEqual(['MOVED.json']);
  expect(migrateLegacyHome(legacy, target).status).toBe('unchanged');
  if (kind === 'absent') expect(existsSync(old)).toBe(false);
});

it.each(['pending', 'rolled-back'] as const)('a %s copy is never committed as a fresh home after the legacy registry disappears', state => {
  const { legacy, target } = migrationFixture();
  migrateLegacyHome(legacy, target, { commit: false });
  if (state === 'rolled-back') rollbackLegacyMigration(target);
  const record = readFileSync(join(target.state, 'migration.json'));
  rmSync(legacy.workspaceConfig);
  rmSync(`${legacy.workspaceConfig}.bak`, { force: true });
  expect(planLegacyMigration(legacy, target).empty).toBe(true);
  expect(() => migrateLegacyHome(legacy, target)).toThrow(new RegExp(`legacy home is empty.*${state} migration copy.*backup`, 's'));
  expect(() => migrateLegacyHome(legacy, target)).toThrow(`(backup ${readMigrationRecord(target)!.backup})`);
  expect(readFileSync(join(target.state, 'migration.json'))).toEqual(record);
  expect(readInstallMarker(target.config)?.state).toBe(state === 'pending' ? 'pending' : undefined);
  expect(json(target.workspaceConfig).saved).toBe('original');
});

it('T1: after a fresh boot, an older binary that writes legacy config.json does not block the next boot', () => {
  const root = storeRoot(), old = join(root, 'legacy');
  const legacy = homePaths(old, join(root, 'cache'), old);
  const target = Home.sandbox(join(root, 'new'), { layout: 'split' });
  const env = { HOME: root, SHELL: '/bin/bash' };
  prepareOperatorHome(target, 'serve', env, { legacy });
  new HomeStore(target).writeJson(target.workspaceConfig, { projects: [], saved: 'split home' });
  rawJson(legacy.workspaceConfig, { projects: [{ id: 'old', root: '/old' }] }); // Older binary.
  expect(prepareOperatorHome(target, 'serve', env, { legacy })).toBe(target);
  expect(json(target.workspaceConfig).saved).toBe('split home');
  expect(readMigrationRecord(target)!.files).toEqual([]);
  expect(json(legacy.workspaceConfig).projects[0].id).toBe('old');
});

it.each(['marked', 'unmarked', 'stale-claim'] as const)('step 1: a %s .bak-only legacy home recovers through the loader and merge writer before migrating', kind => {
  const root = storeRoot();
  const legacy = kind === 'unmarked' ? homePaths(join(root, 'legacy'), join(root, 'cache'), join(root, 'legacy')) : Home.sandbox(join(root, 'legacy'), { layout: 'legacy' });
  const target = Home.sandbox(join(root, 'new'), { layout: 'split' });
  const backup = { projects: [{ id: 'kept', root: '/kept' }], unknown: 'preserved' };
  if (kind === 'unmarked') rawJson(`${legacy.workspaceConfig}.bak`, backup); // A home from before install markers.
  else Home.seed(legacy, `${legacy.workspaceConfig}.bak`, backup);
  if (kind === 'stale-claim') rawJson(join(legacy.root, '.migrating'), { pid: process.pid, startToken: 'a-crashed-migration' });
  expect(migrateLegacyHome(legacy, target).status).toBe('migrated');
  expect(readInstallMarker(legacy.root)?.kind).toBe('test');
  expect(existsSync(join(legacy.root, '.migrating'))).toBe(false);
  expect(json(legacy.workspaceConfig).projects[0].id).toBe('kept');
  expect(json(target.workspaceConfig)).toMatchObject({ unknown: 'preserved', projects: [{ id: 'kept' }] });
  expect(json(`${target.workspaceConfig}.bak`).projects[0].id).toBe('kept');
});

it('step 2: a live cockpit lease refuses migration and names pid, port and instance', () => {
  const { legacy, target } = migrationFixture();
  const release = holdCockpitLease(legacy, 4321, 'named');
  try {
    expect(() => migrateLegacyHome(legacy, target)).toThrow(`pid ${process.pid}, port 4321, instance named`);
    expect(existsSync(join(legacy.root, '.migrating'))).toBe(false);
    expect(readInstallMarker(target.config)?.state).toBeUndefined();
  } finally { release(); }
});

it('step 2: reclaims a stale .migrating holder and refuses a live second migration', () => {
  const { legacy, target } = migrationFixture();
  rawJson(join(legacy.root, '.migrating'), { pid: process.pid, startToken: 'a-different-process-incarnation' });
  let checked = false;
  migrateLegacyHome(legacy, target, { onStep(step) {
    if (step !== 'claimed') return;
    expect(() => migrateLegacyHome(legacy, target)).toThrow(/already running/);
    checked = true;
  } });
  expect(checked).toBe(true);
  expect(existsSync(join(legacy.root, '.migrating'))).toBe(false);
});

it('step 3: a second committed migration is a no-op, even when an old binary later writes', () => {
  const { legacy, target } = migrationFixture();
  migrateLegacyHome(legacy, target);
  const before = statSync(target.workspaceConfig).mtimeMs;
  const record = readFileSync(join(target.state, 'migration.json'));
  rawJson(legacy.workspaceConfig, { saved: 'later outside write' });
  expect(migrateLegacyHome(legacy, target).status).toBe('unchanged');
  expect(statSync(target.workspaceConfig).mtimeMs).toBe(before);
  expect(readFileSync(join(target.state, 'migration.json'))).toEqual(record);
  expect(json(target.workspaceConfig).saved).toBe('original');
});

it('steps 4–5: copies every file family and nested backups into the owning private root with HEAD', () => {
  const { legacy, target } = migrationFixture();
  Home.seed(legacy, legacy.workspaceUiState, { sidebar: 'closed' });
  Home.seed(legacy, legacy.serverState('one'), { port: 4321 });
  Home.seed(legacy, join(legacy.remoteSettings, '4321.json'), { secret: 'kept' });
  for (const path of ['tracker-connections/github.json', 'application-updates/update.json', 'backups/config.json/snapshot.json',
    'remote-settings/backups/4321.json/snapshot.json', 'server-instances/backups/one.json/snapshot.json']) rawJson(join(legacy.root, path), { path });
  writeFileSync(legacy.serverLock(), 'old lock');
  const result = migrateLegacyHome(legacy, target);
  for (const path of [target.workspaceConfig, target.workspaceUiState, target.serverState('one'), join(target.remoteSettings, '4321.json'),
    join(target.config, 'tracker-connections/github.json'), join(target.state, 'application-updates/update.json'),
    join(target.backups, 'config.json/snapshot.json'), join(target.backups, 'remote-settings/4321.json/snapshot.json'),
    join(target.backups, 'server-instances/one.json/snapshot.json'), join(target.state, 'migration.json'), result.record!.backup]) {
    expect(existsSync(path), path).toBe(true);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777, path).toBe(0o600);
  }
  expect(existsSync(target.serverLock())).toBe(false);
  expect(json(join(target.state, '.versions/server-instances/one.json/HEAD')).hash).toMatch(/^[a-f0-9]{64}$/);
  expect(journals(target).sort()).toEqual(['config.json/HEAD', 'remote-settings/4321.json/HEAD', 'server-instances/one.json/HEAD', 'ui-state.json/HEAD']);
  expect(getHomeRecovery(target)).toEqual({ files: [] });
});

it.each(['outside-write', 'reset'])('step 5: refuses unresolved %s recovery without changing legacy bytes', reason => {
  const { legacy, target } = migrationFixture();
  if (reason === 'reset') {
    Home.seed(legacy, legacy.workspaceConfig, { projects: [{ id: 'kept', root: '/kept' }] });
    Home.seed(legacy, legacy.workspaceConfig, { projects: [] });
  } else rawJson(legacy.workspaceConfig, { projects: [], outside: true });
  const bytes = readFileSync(legacy.workspaceConfig);
  expect(() => migrateLegacyHome(legacy, target)).toThrow(new RegExp(`config.json \\(${reason}\\)`));
  expect(readFileSync(legacy.workspaceConfig)).toEqual(bytes);
  expect(existsSync(join(legacy.root, '.migrating'))).toBe(false);
});

it('step 5: the recovery refusal names every file that needs recovery', () => {
  const { legacy, target } = migrationFixture();
  Home.seed(legacy, legacy.workspaceUiState, { sidebar: 'open' });
  rawJson(legacy.workspaceConfig, { projects: [], outside: true });
  rawJson(legacy.workspaceUiState, { sidebar: 'outside' });
  expect(() => migrateLegacyHome(legacy, target)).toThrow('config.json (outside-write), ui-state.json (outside-write)');
  expect(readInstallMarker(target.config)?.state).toBeUndefined();
});

it('step 6: recopies an older-binary write before commit, including new and deleted files', () => {
  const { legacy, target } = migrationFixture();
  Home.seed(legacy, legacy.serverState('deleted'), { existed: true });
  const steps: string[] = [];
  const result = migrateLegacyHome(legacy, target, { onStep(step, attempt) {
    steps.push(`${step} ${attempt}`);
    if (step === 'recheck' && attempt === 0) {
      rawJson(legacy.workspaceConfig, { projects: [], saved: 'newer' });
      rawJson(join(legacy.remoteSettings, '7777.json'), { token: 'added' });
      rmSync(legacy.serverState('deleted')); // Older writers do not use HomeStore.
    }
  } });
  // Accounts copy only once the legacy inventory settles.
  expect(steps).toEqual(['recovered 0', 'claimed 0', 'pending 0', 'archived 0', 'copied 0', 'recheck 0', 'recheck 1', 'accounts 1', 'committed 1']);
  expect(json(target.workspaceConfig).saved).toBe('newer');
  expect(json(join(target.remoteSettings, '7777.json')).token).toBe('added');
  expect(existsSync(target.serverState('deleted'))).toBe(false);
  expect(result.record!.files).toEqual([...planLegacyMigration(legacy, target).files,
    { path: 'server-instances/deleted.json', hash: null, mtimeMs: null, target: { kind: 'state', path: 'server-instances/deleted.json' } }]);
  expect(result.record!.files.find(file => file.path === 'config.json')?.target).toEqual({ kind: 'config', path: 'config.json' });
  expect(getHomeRecovery(target)).toEqual({ files: [] });
});

it('step 6: three older-binary writes abort with the filename and process diagnostic', () => {
  const { legacy, target } = migrationFixture();
  let checks = 0;
  expect(() => migrateLegacyHome(legacy, target, { onStep(step, attempt) {
    if (step !== 'recheck') return;
    if (++checks > 3) throw new Error('a fourth check ran');
    rawJson(legacy.workspaceConfig, { projects: [], attempt });
  } })).toThrow(/config.json.*Stop older binaries.*Running processes/s);
  expect(checks).toBe(3);
  expect(readInstallMarker(target.config)?.state).toBe('pending');
  expect(existsSync(join(legacy.root, 'MOVED.json'))).toBe(false);
  expect(existsSync(join(legacy.root, '.migrating'))).toBe(false);
});

it.skipIf(process.platform === 'win32')('step 6: the writer diagnostic names running Squawk processes and leaves out other processes', async () => {
  const { legacy, target } = migrationFixture();
  const start = (...args: string[]) => spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)", ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  const older = start('cez', 'serve'), other = start('unrelated');
  try {
    await Promise.all([once(older.stdout, 'data'), once(other.stdout, 'data')]);
    let message = '';
    try {
      migrateLegacyHome(legacy, target, { onStep(step, attempt) { if (step === 'recheck') rawJson(legacy.workspaceConfig, { projects: [], attempt }); } });
    } catch (error) { message = (error as Error).message; }
    const processes = message.split('Running processes (pid and command):\n')[1]!.split('\n').map(line => line.trim());
    expect(processes).toContainEqual(expect.stringMatching(new RegExp(`^${older.pid} .* cez serve$`)));
    expect(processes.filter(line => line.startsWith(`${other.pid} `))).toEqual([]);
  } finally { older.kill(); other.kill(); }
});

it('D13: copying a running legacy managed installation into an empty target never changes its source', () => {
  const { legacy, target, env } = migrationFixture();
  const entry = join(legacy.versions, '1.2.3/node_modules/@wjarka/cezarion/dist/index.js');
  mkdirSync(join(entry, '..'), { recursive: true });
  const bytes = Buffer.from('export const runningFromLegacy = true;\n');
  writeFileSync(entry, bytes); // Fixture managed vendor file, outside the registry writer.
  rawJson(join(legacy.versions, '1.2.3/.cezar-install.json'), { version: '1.2.3', source: 'registry' });
  writeFileSync(join(legacy.versions, 'current'), '1.2.3');
  const before = statSync(entry);
  expect(existsSync(target.versions)).toBe(false);
  migrateLegacyHome(legacy, target, { env });
  const copied = join(target.versions, '1.2.3/node_modules/@wjarka/cezarion/dist/index.js');
  expect(readFileSync(copied)).toEqual(bytes);
  expect(readFileSync(entry)).toEqual(bytes);
  expect(statSync(entry).ino).toBe(before.ino);
  expect(statSync(entry).mtimeMs).toBe(before.mtimeMs);
  expect(readFileSync(join(legacy.versions, 'current'), 'utf8')).toBe('1.2.3');
  expect(readInstallMarker(target.config)?.state).toBe('committed');
});

it.each(['one file', 'the whole install'] as const)('step 6: recopy removes managed files when an older binary deletes %s', removed => {
  const { legacy, target } = migrationFixture();
  rawJson(join(legacy.versions, 'v1/removed.json'), { stale: true });
  rawJson(join(legacy.versions, 'v1/kept.json'), { kept: true });
  migrateLegacyHome(legacy, target, { env: {}, onStep(step, attempt) {
    if (step !== 'recheck' || attempt !== 0) return;
    rmSync(removed === 'one file' ? join(legacy.versions, 'v1/removed.json') : legacy.versions, { recursive: true });
    rawJson(legacy.workspaceConfig, { projects: [], saved: 'same recheck' });
  } });
  expect(json(target.workspaceConfig).saved).toBe('same recheck');
  expect(existsSync(join(target.versions, 'v1/removed.json'))).toBe(false);
  if (removed === 'one file') expect(json(join(target.versions, 'v1/kept.json'))).toEqual({ kept: true });
  else expect(existsSync(target.versions)).toBe(false);
  expect(readInstallMarker(target.config)?.state).toBe('committed');
});

it('step 8: pending copies refuse ordinary writes, allow leases, commit once, and record every root in MOVED.json', () => {
  const { legacy, target } = migrationFixture();
  expect(migrateLegacyHome(legacy, target, { commit: false }).status).toBe('pending');
  expect(readMigrationRecord(target)!.stagedAt).toEqual(expect.any(String));
  expect(() => new HomeStore(target).writeJson(target.workspaceConfig, {})).toThrow(/pending migration/);
  const release = holdCockpitLease(target, 4322, 'pending-instance');
  release();
  expect(existsSync(join(legacy.root, 'MOVED.json'))).toBe(false);
  commitLegacyMigration(target, {});
  expect(readInstallMarker(target.config)).toMatchObject({ state: 'committed', migratedFrom: legacy.root });
  expect(json(join(legacy.root, 'MOVED.json')).roots).toEqual(readMigrationRecord(target)!.roots);
  const moved = statSync(join(legacy.root, 'MOVED.json'));
  commitLegacyMigration(target, {});
  expect(statSync(join(legacy.root, 'MOVED.json'))).toMatchObject({ ino: moved.ino, mtimeMs: moved.mtimeMs });
  expect(new HomeStore(target).read(target.workspaceConfig)).toContain('original');
});

it('step 8: final commit refuses changes made to legacy during a pending group health check', () => {
  const { legacy, target } = migrationFixture();
  migrateLegacyHome(legacy, target, { commit: false });
  rawJson(legacy.workspaceConfig, { changedWhilePending: true });
  expect(() => commitLegacyMigration(target)).toThrow(/config.json/);
  expect(readInstallMarker(target.config)?.state).toBe('pending');
});

it('a pending home with a live target cockpit cannot be overwritten by another migration', () => {
  const { legacy, target } = migrationFixture();
  migrateLegacyHome(legacy, target, { commit: false });
  const releaseLegacy = holdCockpitLease(legacy, 4321, 'old');
  const release = holdCockpitLease(target, 4333, 'health-check');
  try {
    expect(() => migrateLegacyHome(legacy, target))
      .toThrow(`pid ${process.pid}, port 4321, instance old; pid ${process.pid}, port 4333, instance health-check`);
  } finally { release(); releaseLegacy(); }
  expect(json(target.workspaceConfig).saved).toBe('original');
});

it('rolls back to install.json.failed and overwrites the crashed pending home on the next migration', () => {
  const { legacy, target } = migrationFixture();
  migrateLegacyHome(legacy, target, { commit: false });
  rollbackLegacyMigration(target);
  expect(existsSync(join(target.config, 'install.json.failed'))).toBe(true);
  rawJson(target.workspaceConfig, { crashResidue: true });
  expect(migrateLegacyHome(legacy, target).status).toBe('migrated');
  expect(json(target.workspaceConfig).saved).toBe('original');
  expect(json(target.workspaceConfig).crashResidue).toBeUndefined();
});

it('rejects an invalid JSON copy before committing and leaves the legacy data unchanged', () => {
  const { legacy, target } = migrationFixture();
  const path = join(legacy.root, 'tracker-connections', 'invalid.json');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'invalid JSON');
  expect(() => migrateLegacyHome(legacy, target)).toThrow(SyntaxError);
  expect(readFileSync(path, 'utf8')).toBe('invalid JSON');
  expect(readInstallMarker(target.config)?.state).toBe('pending');
});

it('the shared dry-run planner inventories without creating a marker, journal or target', () => {
  const { legacy, target } = migrationFixture();
  rmSync(join(target.config, 'install.json'));
  const before = readdirSync(legacy.root);
  const plan = planLegacyMigration(legacy, target);
  expect(plan.files.some(file => file.path === 'config.json')).toBe(true);
  expect(plan.backup).toContain('legacy-cezar-home-');
  expect(readdirSync(legacy.root)).toEqual(before);
  expect(readInstallMarker(target.config)).toBeUndefined();
});

it('a migration that another process commits while this one waits for the claim reports unchanged', () => {
  const { legacy, target } = migrationFixture();
  let committed: unknown;
  const result = migrateLegacyHome(legacy, target, { onStep(step) {
    if (step !== 'recovered') return;
    expect(migrateLegacyHome(legacy, target).status).toBe('migrated');
    committed = readMigrationRecord(target);
  } });
  expect(result).toEqual({ status: 'unchanged', record: committed });
  expect(readInstallMarker(target.config)?.state).toBe('committed');
  expect(json(target.workspaceConfig).saved).toBe('original');
});

it('a target that already holds registry data refuses migration and keeps its files', () => {
  const { legacy, target } = migrationFixture();
  const settings = join(target.remoteSettings, '4321.json');
  Home.seed(target, settings, { owner: 'target' });
  expect(() => migrateLegacyHome(legacy, target)).toThrow(/already contains registry data/);
  expect(json(settings)).toEqual({ owner: 'target' });
  expect(existsSync(target.workspaceConfig)).toBe(false);
  expect(readInstallMarker(target.config)?.state).toBeUndefined();
});

/** Journal keys that have a HEAD, per root: only HomeStore files keep a journal. */
function journals(target: Home): string[] {
  return [target.config, target.state].flatMap(root => migrationFiles(join(root, '.versions')).filter(key => key.endsWith('/HEAD')));
}

it('a retry after a failed copy removes copies of legacy files deleted in between', () => {
  const { legacy, target } = migrationFixture();
  Home.seed(legacy, join(legacy.remoteSettings, '4321.json'), { secret: 'removed later' });
  rawJson(join(legacy.root, 'tracker-connections/github.json'), { token: 'removed later' });
  rawJson(join(legacy.skillsCache, 'team/skill.json'), { cached: true });
  const invalid = join(legacy.root, 'tracker-connections/zz-invalid.json');
  writeFileSync(invalid, 'invalid JSON');
  expect(() => migrateLegacyHome(legacy, target)).toThrow(SyntaxError);
  expect(json(join(target.config, 'tracker-connections/github.json')).token).toBe('removed later');
  new HomeStore(legacy).replace(join(legacy.remoteSettings, '4321.json'), null);
  rmSync(join(legacy.root, 'tracker-connections/github.json'));
  rawJson(invalid, { fixed: true });
  expect(migrateLegacyHome(legacy, target).status).toBe('migrated');
  expect(existsSync(join(target.remoteSettings, '4321.json'))).toBe(false);
  expect(existsSync(join(target.config, 'tracker-connections/github.json'))).toBe(false);
  expect(json(join(target.config, 'tracker-connections/zz-invalid.json'))).toEqual({ fixed: true });
  expect(journals(target).sort()).toEqual(['agent-accounts.json/HEAD', 'config.json/HEAD', 'remote-settings/4321.json/HEAD']);
  expect(getHomeRecovery(target)).toEqual({ files: [] });
});

it('a retry removes a file that an older binary added during the recheck of a failed run', () => {
  const { legacy, target } = migrationFixture();
  const added = join(legacy.remoteSettings, '7777.json'), invalid = join(legacy.root, 'tracker-connections/invalid.json');
  expect(() => migrateLegacyHome(legacy, target, { onStep(step, attempt) {
    if (step !== 'recheck' || attempt !== 0) return;
    rawJson(added, { token: 'added during recheck' });
    rawJson(invalid, {});
    writeFileSync(invalid, 'invalid JSON');
  } })).toThrow(SyntaxError);
  expect(json(join(target.remoteSettings, '7777.json')).token).toBe('added during recheck');
  rmSync(added);
  rawJson(invalid, { fixed: true });
  expect(migrateLegacyHome(legacy, target).status).toBe('migrated');
  expect(existsSync(join(target.remoteSettings, '7777.json'))).toBe(false);
  expect(getHomeRecovery(target)).toEqual({ files: [] });
});

it('a retry after a staged copy removes the managed install and its launchers that the legacy home no longer has', () => {
  const { legacy, target } = migrationFixture();
  rawJson(join(legacy.versions, 'v1/package.json'), { version: '1.0.0' });
  migrateLegacyHome(legacy, target, { env: {}, commit: false });
  rollbackLegacyMigration(target);
  expect(json(join(target.versions, 'v1/package.json')).version).toBe('1.0.0');
  expect(readdirSync(target.bin).sort()).toEqual(['cez', 'cezarion', 'hsq']);
  rmSync(legacy.versions, { recursive: true });
  expect(migrateLegacyHome(legacy, target, { env: {} }).status).toBe('migrated');
  expect(existsSync(target.versions)).toBe(false);
  // Launchers of the discarded copy would start a versions/ tree that no longer exists.
  expect(existsSync(target.bin)).toBe(false);
});

it('a retry keeps bin/ files that the pending copy did not write', () => {
  const { legacy, target } = migrationFixture();
  rawJson(join(legacy.versions, 'v1/package.json'), { version: '1.0.0' });
  mkdirSync(target.bin, { recursive: true });
  writeFileSync(join(target.bin, 'operator-tool'), '#!/bin/sh\n', { flag: 'wx' }); // The operator's own tool.
  migrateLegacyHome(legacy, target, { env: {}, commit: false });
  rollbackLegacyMigration(target);
  rmSync(legacy.versions, { recursive: true });
  expect(migrateLegacyHome(legacy, target, { env: {} }).status).toBe('migrated');
  expect(readdirSync(target.bin)).toEqual(['operator-tool']);
});

it.skipIf(process.platform === 'win32')('a retry keeps the state root, its archive, record and lock when XDG_STATE_HOME lies inside bin/', () => {
  const { legacy } = migrationFixture();
  const data = storeRoot();
  const roots = platformKindRoots(storeRoot(), {
    XDG_DATA_HOME: data, XDG_STATE_HOME: join(data, 'hearsay-squawk', 'bin'), XDG_CONFIG_HOME: storeRoot(),
  }, 'linux');
  const target = kindHomePaths(roots, 'split', 'linux');
  expect(target.state).toBe(join(target.bin, 'hearsay-squawk'));
  createInstallMarker(target.config, 'test');
  const first = migrateLegacyHome(legacy, target, { commit: false }).record!;
  rollbackLegacyMigration(target);
  expect(migrateLegacyHome(legacy, target).status).toBe('migrated');
  expect(existsSync(first.backup)).toBe(true);
  expect(readMigrationRecord(target)?.backup).toEqual(expect.stringContaining(target.backups));
  expect(existsSync(join(target.state, '.locks'))).toBe(true);
  expect(json(target.workspaceConfig).saved).toBe('original');
});

it.each(['settled', 'rechecked'] as const)('migrating a legacy home without a managed install keeps the managed install already in the target (%s copy)', copy => {
  const { legacy, target } = migrationFixture();
  rawJson(join(target.versions, 'v2/package.json'), { version: '2.0.0' });
  expect(migrateLegacyHome(legacy, target, { env: {}, onStep(step, attempt) {
    if (copy === 'rechecked' && step === 'recheck' && attempt === 0) rawJson(legacy.workspaceConfig, { projects: [], saved: 'newer' });
  } }).status).toBe('migrated');
  expect(json(join(target.versions, 'v2/package.json')).version).toBe('2.0.0');
});

it('after a crash inside a fresh decision, a later legacy write migrates without removing the target managed install', () => {
  const root = storeRoot(), old = join(root, 'legacy');
  mkdirSync(old);
  const legacy = homePaths(old, join(root, 'cache'), old);
  const target = Home.sandbox(join(root, 'new'), { layout: 'split' });
  const write = installMarker.writeMigrationMarker;
  vi.spyOn(installMarker, 'writeMigrationMarker').mockImplementation((path, from, state) => {
    if (state === 'committed') throw new Error('crash before the committed marker');
    return write(path, from, state);
  });
  expect(() => migrateLegacyHome(legacy, target)).toThrow('crash before the committed marker');
  vi.restoreAllMocks();
  expect(readMigrationRecord(target)?.files).toEqual([]);
  rawJson(join(target.versions, 'v2/package.json'), { version: '2.0.0' });
  rawJson(legacy.workspaceConfig, { projects: [], saved: 'older binary' });
  expect(migrateLegacyHome(legacy, target, { env: {} }).status).toBe('migrated');
  expect(json(join(target.versions, 'v2/package.json')).version).toBe('2.0.0');
  expect(json(target.workspaceConfig).saved).toBe('older binary');
});

it.skipIf(process.platform === 'win32')('a retry with shared XDG roots discards only migration copies and keeps the first attempt backup', () => {
  const { legacy } = migrationFixture();
  const shared = storeRoot();
  const roots = platformKindRoots(storeRoot(), { XDG_CONFIG_HOME: shared, XDG_STATE_HOME: shared, XDG_DATA_HOME: shared }, 'linux');
  expect(roots.data).toBe(roots.config);
  const target = kindHomePaths(roots, 'split', 'linux');
  createInstallMarker(target.config, 'test');
  rawJson(join(legacy.versions, 'v1/package.json'), { version: '1.0.0' });
  const first = migrateLegacyHome(legacy, target, { env: {}, commit: false }).record!;
  rollbackLegacyMigration(target);
  const retry = migrateLegacyHome(legacy, target, { env: {} });
  expect(retry.status).toBe('migrated');
  expect(existsSync(first.backup)).toBe(true);
  expect(readInstallMarker(target.config)?.state).toBe('committed');
  expect(json(target.workspaceConfig).saved).toBe('original');
  expect(json(join(target.versions, 'v1/package.json')).version).toBe('1.0.0');
  expect(readdirSync(target.bin).sort()).toEqual(['cez', 'cezarion', 'hsq']);
});

it.each(['pending versions directory', 'pending bin directory', 'legacy MOVED.json', 'rolled-back marker'] as const)(
  'a %s that links outside its home is refused and its link target stays untouched', kind => {
    const { legacy, target } = migrationFixture();
    const outside = storeRoot();
    rawJson(join(outside, 'kept.json'), { owner: 'outside' });
    rawJson(join(legacy.versions, 'v1/package.json'), { version: '1.0.0' });
    if (kind === 'legacy MOVED.json') symlinkSync(join(outside, 'kept.json'), join(legacy.root, 'MOVED.json'));
    else migrateLegacyHome(legacy, target, { env: {}, commit: false });
    if (kind === 'pending versions directory') {
      rmSync(target.versions, { recursive: true });
      symlinkSync(outside, target.versions, 'dir');
    }
    if (kind === 'pending bin directory') {
      rmSync(target.bin, { recursive: true });
      symlinkSync(outside, target.bin, 'dir');
      rawJson(join(outside, 'cez'), { owner: 'outside' });
    }
    if (kind === 'rolled-back marker') symlinkSync(join(outside, 'kept.json'), join(target.config, 'install.json.failed'));
    const act = () => kind === 'rolled-back marker' ? rollbackLegacyMigration(target) : migrateLegacyHome(legacy, target, { env: {} });
    expect(act).toThrow(/escapes canonical HomeStore root/);
    expect(readdirSync(outside).sort()).toEqual(kind === 'pending bin directory' ? ['cez', 'kept.json'] : ['kept.json']);
    expect(json(join(outside, 'kept.json'))).toEqual({ owner: 'outside' });
    if (kind === 'rolled-back marker') expect(readInstallMarker(target.config)?.state).toBe('pending');
  });

it('an older binary that deletes a connection file during the copy leaves no copy of it', () => {
  const { legacy, target } = migrationFixture();
  const connection = join(legacy.root, 'tracker-connections/github.json');
  rawJson(connection, { token: 'deleted during copy' });
  const result = migrateLegacyHome(legacy, target, { onStep(step) { if (step === 'archived') rmSync(connection); } });
  expect(result.status).toBe('migrated');
  expect(existsSync(join(target.config, 'tracker-connections/github.json'))).toBe(false);
  expect(result.record!.files.find(file => file.path === 'tracker-connections/github.json')).toMatchObject({ hash: null });
});

it('a copy that does not read back as the legacy bytes aborts before commit', () => {
  const { legacy, target } = migrationFixture();
  rawJson(join(legacy.root, 'tracker-connections/github.json'), { token: 'kept' });
  const copy = join(target.config, 'tracker-connections/github.json');
  const replace = privateFiles.replacePrivate;
  vi.spyOn(privateFiles, 'replacePrivate').mockImplementation((path, bytes, options) => replace(path, path === copy ? '{"torn' : bytes, options));
  expect(() => migrateLegacyHome(legacy, target)).toThrow(/verification failed: tracker-connections\/github\.json/);
  expect(readInstallMarker(target.config)?.state).toBe('pending');
  expect(existsSync(join(legacy.root, 'MOVED.json'))).toBe(false);
});

it.each(['target directory', 'legacy file', 'target backups', 'pending copy'] as const)(
  'migration refuses a %s that links outside its home and never writes or deletes there', kind => {
    const { legacy, target } = migrationFixture();
    const outside = storeRoot();
    rawJson(join(outside, 'github.json'), { owner: 'outside' });
    rawJson(join(legacy.root, 'tracker-connections/github.json'), { owner: 'legacy' });
    if (kind === 'pending copy') migrateLegacyHome(legacy, target, { commit: false });
    if (kind === 'target directory' || kind === 'pending copy') {
      rmSync(join(target.config, 'tracker-connections'), { recursive: true, force: true });
      symlinkSync(outside, join(target.config, 'tracker-connections'), 'dir');
    }
    if (kind === 'legacy file') {
      rmSync(join(legacy.root, 'tracker-connections/github.json'));
      symlinkSync(join(outside, 'github.json'), join(legacy.root, 'tracker-connections/github.json'));
    }
    if (kind === 'target backups') { mkdirSync(target.state, { recursive: true }); symlinkSync(outside, target.backups, 'dir'); }
    expect(() => migrateLegacyHome(legacy, target)).toThrow(/escapes canonical HomeStore root/);
    expect(readdirSync(outside)).toEqual(['github.json']);
    expect(json(join(outside, 'github.json'))).toEqual({ owner: 'outside' });
    if (kind === 'legacy file') expect(existsSync(join(target.config, 'tracker-connections/github.json'))).toBe(false);
  });

it('the legacy backup archive keeps every legacy file and directory except installs, temporary files and a nested target', () => {
  const root = storeRoot();
  const legacy = Home.sandbox(join(root, 'legacy'), { layout: 'legacy' });
  const target = Home.sandbox(join(legacy.root, 'squawk'), { layout: 'split' });
  Home.seed(legacy, legacy.workspaceConfig, { projects: [], saved: 'original' });
  Home.seed(legacy, join(legacy.remoteSettings, '4321.json'), { secret: 'archived' });
  for (const path of ['versions/v1/package.json', 'bin/cez', 'tmp/partial.json']) rawJson(join(legacy.root, path), { path });
  const result = migrateLegacyHome(legacy, target, { env: {} });
  const entries = execFileSync('tar', ['-tzf', result.record!.backup], { encoding: 'utf8' }).split('\n').filter(Boolean);
  // Journal entries are named by content hash; the archive keeps them under .versions.
  expect(entries.filter(entry => !entry.startsWith('.versions/'))).toEqual(['.versions', 'config.json', 'install.json', 'remote-settings', 'remote-settings/4321.json', 'squawk']);
  expect(json(target.workspaceConfig).saved).toBe('original');
});

it('rollback makes the rolled-back marker durable by flushing the config directory after the rename', () => {
  const { legacy, target } = migrationFixture();
  migrateLegacyHome(legacy, target, { commit: false });
  const marker = join(target.config, 'install.json');
  const flushed: Array<{ failed: boolean; marker: boolean }> = [];
  const sync = privateFiles.syncDirectory;
  vi.spyOn(privateFiles, 'syncDirectory').mockImplementation(path => {
    if (path === target.config) flushed.push({ failed: existsSync(`${marker}.failed`), marker: existsSync(marker) });
    sync(path);
  });
  rollbackLegacyMigration(target);
  expect(flushed).toContainEqual({ failed: true, marker: false });
});

it('rollback refuses a committed migration and keeps the committed marker', () => {
  const { legacy, target } = migrationFixture();
  migrateLegacyHome(legacy, target);
  expect(() => rollbackLegacyMigration(target)).toThrow('Only a pending migration can be rolled back');
  expect(readInstallMarker(target.config)?.state).toBe('committed');
  expect(existsSync(join(target.config, 'install.json.failed'))).toBe(false);
});

it.each(['rolled back', 'removed'] as const)('commit refuses a staged copy whose target marker was %s and publishes nothing', marker => {
  const { legacy, target } = migrationFixture();
  migrateLegacyHome(legacy, target, { commit: false });
  if (marker === 'rolled back') rollbackLegacyMigration(target);
  else rmSync(join(target.config, 'install.json'));
  expect(() => commitLegacyMigration(target, {})).toThrow(/without an install marker/);
  expect(readInstallMarker(target.config)).toBeUndefined();
  expect(existsSync(join(target.config, 'install.json.failed'))).toBe(marker === 'rolled back');
  expect(existsSync(join(legacy.root, 'MOVED.json'))).toBe(false);
});

it('a home migrated from one legacy root refuses another legacy root', () => {
  const { legacy, target } = migrationFixture();
  migrateLegacyHome(legacy, target);
  const other = Home.sandbox(join(storeRoot(), 'other'), { layout: 'legacy' });
  Home.seed(other, other.workspaceConfig, { projects: [], saved: 'other' });
  expect(() => migrateLegacyHome(other, target)).toThrow(`Home already migrated from ${legacy.root}`);
  expect(json(target.workspaceConfig).saved).toBe('original');
  expect(existsSync(join(other.root, 'MOVED.json'))).toBe(false);
});
