import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Home } from '../../home/home.ts';
import { cleanStoreRoots } from '../../home/store.testkit.ts';
import { certbotSite, installInstance, serverFixture, serverMigrate, type InstanceSpec, type ServerFixture } from '../server-migrate.testkit.ts';
import { loadServerState } from '../state.ts';
import { StepAborted } from '../steps.ts';
import { STEP_STATUSES, type InstallContext, type PlatformMigrationReport, type ServerState, type StepArtifact, type Ui } from '../types.ts';
import { createAutoUi } from '../ui.ts';
import { createUbuntuVps, nginxVhost, systemdUnit } from './ubuntu-vps.ts';
import { environmentDetails, migrateUbuntu, publicTarget, rollbackUbuntuMigration } from './ubuntu-vps-migration.ts';

afterEach(cleanStoreRoots);

type Move = PlatformMigrationReport['moved'][number];
const { done, skipped } = z.enum(STEP_STATUSES).enum;

const DEFAULT: InstanceSpec = { instance: 'default', port: 4321, domain: 'cockpit.example.com' };
const SHOP: InstanceSpec = { instance: 'shop', port: 4322, domain: 'shop.example.com', scope: 'system' };

function context(f: ServerFixture, state: ServerState, over: Partial<InstallContext> = {}): InstallContext {
  return { home: f.legacy, state: structuredClone(state), ui: createAutoUi(), runner: f.host, instance: state.instance ?? 'default', save: async () => {},
    dryRun: false, assumeYes: true, reconfigure: new Set(), repoRoot: '/srv/repo', now: '2026-11-07T00:00:00.000Z', prefs: {}, ...over };
}

function install(spec: InstanceSpec) {
  const f = serverFixture();
  return { f, state: installInstance(f, spec) };
}

const unitRecord = (state: ServerState) => state.steps.autostart!.created!.artifacts[0]!;
const siteRecords = (state: ServerState) => state.steps['nginx-proxy']!.created!.artifacts;
const userUnit = (f: ServerFixture, name: string) => join(f.host.userUnitDir, name);
function without<K extends 'domain' | 'bindHost'>(state: ServerState, key: K): ServerState {
  const copy = { ...state };
  delete copy[key];
  return copy;
}

/** The moves of the default user install with its nginx site, in the order the plan lists them. */
function defaultMoves(f: ServerFixture, state: ServerState): [Move, Move, Move, Move] {
  const unit = unitRecord(state);
  const [file, link, htpasswd] = siteRecords(state) as [StepArtifact, StepArtifact, StepArtifact];
  return [
    { stepId: 'autostart', from: unit, to: { ...unit, name: 'hearsay-squawk.service', path: userUnit(f, 'hearsay-squawk.service') },
      backup: { kind: 'owned', type: 'file', path: `${userUnit(f, 'cezar.service')}.migrated` } },
    { stepId: 'nginx-proxy', from: file, to: { ...file, path: '/etc/nginx/sites-available/hearsay-squawk' } },
    { stepId: 'nginx-proxy', from: link, to: { ...link, path: '/etc/nginx/sites-enabled/hearsay-squawk' } },
    { stepId: 'nginx-proxy', from: htpasswd, to: { ...htpasswd, path: '/etc/hearsay-squawk/htpasswd' } },
  ];
}

/** An operator who answers the delegate prompts: runs the shown root command, or only says so. */
function operatorUi(f: ServerFixture, runsCommands: boolean, read: string[] = []): Ui {
  let shown = '';
  const prefix = 'sudo bash -lc ';
  return {
    ...createAutoUi(),
    info: (m: string) => { read.push(m); },
    message: (m: string) => { if (m.startsWith(prefix)) shown = m.slice(prefix.length); },
    confirm: async ({ message }) => {
      if (message !== 'Have you run it as root?') return false;
      if (runsCommands) f.host.shell(shown.slice(1, -1).replaceAll(`'\\''`, `'`));
      return true;
    },
  };
}

describe('environment lines in the migration plan', () => {
  const unit = (...lines: string[]) => systemdUnit('/srv/repo', 4321, 'user', '/usr/bin/node /opt/cezar/dist/index.js')
    .replace(/(Environment=PATH=.*\n)/, `$1${lines.map(line => `${line}\n`).join('')}`);

  it.each([
    ['an installer unit names nothing', [], []],
    ['a custom home shows its path', ['Environment=CEZ_HOME=/srv/cez-home'], ['environment CEZ_HOME=/srv/cez-home carried']],
    ['a quoted home with a space shows the whole path', ['Environment=CEZ_HOME="/srv/my home"'], ['environment CEZ_HOME=/srv/my home carried']],
    ['each assignment on one line is named without its value', ['Environment="GH_TOKEN=secret" "HTTPS_PROXY=http://proxy:3128"'],
      ['environment GH_TOKEN carried (value not shown)', 'environment HTTPS_PROXY carried (value not shown)']],
    ['installer variables set again by the operator stay unnamed', ['Environment=PATH=/opt/bin', 'Environment=HSQ_REMOTE=1 CEZ_REMOTE=1'], []],
  ])('%s', (_case, lines, details) => {
    expect(environmentDetails(unit(...lines))).toEqual(details);
  });
});

describe('the public URL the health check probes', () => {
  const plain = nginxVhost(4321, 'cockpit.example.com');
  const tls = certbotSite(plain, 'cockpit.example.com');
  const tlsCommentedOut = tls.replace(/^( *)(listen 443|ssl_certificate)/gm, '$1# $2');

  it.each([
    ['no recorded domain', undefined, plain, { url: 'http://127.0.0.1/' }],
    ['a plain site', 'cockpit.example.com', plain, { url: 'http://cockpit.example.com/', resolve: 'cockpit.example.com:80:127.0.0.1' }],
    ['a site with TLS', 'cockpit.example.com', tls, { url: 'https://cockpit.example.com/', resolve: 'cockpit.example.com:443:127.0.0.1' }],
    ['a site whose TLS lines the operator commented out', 'cockpit.example.com', tlsCommentedOut, { url: 'http://cockpit.example.com/', resolve: 'cockpit.example.com:80:127.0.0.1' }],
  ])('%s', (_case, domain, site, target) => {
    const { f, state } = install(DEFAULT);
    expect(publicTarget(context(f, domain ? { ...state, domain } : without(state, 'domain')), site)).toEqual(target);
  });
});

describe('ubuntu-vps migrate and rollback', () => {
  it('moves the unit and site of a user install, and rollback restores the old ones', async () => {
    const { f, state } = install(DEFAULT);
    const moves = defaultMoves(f, state);
    const [unit, available, enabled, htpasswd] = moves;
    await expect(migrateUbuntu(context(f, state))).resolves.toEqual({ moved: moves, leftAloneForeign: [], errors: [], details: [
      `unit user cezar.service → hearsay-squawk.service (old file kept as ${userUnit(f, 'cezar.service')}.migrated)`,
      'site /etc/nginx/sites-available/cezar → /etc/nginx/sites-available/hearsay-squawk (copied; auth_basic_user_file /etc/cezar/htpasswd → /etc/hearsay-squawk/htpasswd)',
      'enabled site /etc/nginx/sites-enabled/cezar → /etc/nginx/sites-enabled/hearsay-squawk',
      'file /etc/cezar/htpasswd → /etc/hearsay-squawk/htpasswd (copied; old file kept)',
      'health check: port 4321 answers, then http://cockpit.example.com/ (HTTP, the site has no TLS) asks for a login and accepts a probe login',
    ] });
    expect(f.host.unit('user', 'hearsay-squawk.service').enabled).toBe(true);
    expect(f.host.enabledSites()).toEqual(['hearsay-squawk']);

    await expect(rollbackUbuntuMigration(context(f, state), { moved: moves, leftAloneForeign: [], errors: [] })).resolves.toEqual({ moved: [
      { stepId: 'nginx-proxy', from: available.to, to: available.from },
      { stepId: 'nginx-proxy', from: enabled.to, to: enabled.from },
      { stepId: 'nginx-proxy', from: htpasswd.to, to: htpasswd.from },
      { stepId: 'autostart', from: unit.to, to: unit.from, backup: unit.backup },
    ], leftAloneForeign: [], errors: [] });
    expect(f.host.unit('user', 'cezar.service').enabled).toBe(true);
    expect(existsSync(userUnit(f, 'hearsay-squawk.service'))).toBe(false);
    expect(f.host.enabledSites()).toEqual(['cezar']);
    expect(f.host.exists('/etc/hearsay-squawk')).toBe(false);
  });

  it.each([
    ['its recorded bind address', '10.0.0.5', 'http://10.0.0.5:4400/'],
    ['no recorded bind address', undefined, 'http://127.0.0.1:4400/'],
  ])('plans only the unit of an --external-proxy install and checks %s', async (_case, bindHost, url) => {
    const { f, state } = install({ instance: 'api', port: 4400, domain: 'api.example.com', externalProxy: true });
    const report = await migrateUbuntu(context(f, bindHost ? { ...state, bindHost } : without(state, 'bindHost'), { dryRun: true }));
    expect(report.moved.map(m => m.to.name)).toEqual(['hearsay-squawk-api.service']);
    expect(report.details).toEqual([
      `unit user cezar-api.service → hearsay-squawk-api.service (old file kept as ${userUnit(f, 'cezar-api.service')}.migrated)`,
      'external proxy: its routes, TLS and authentication stay with the operator',
      `health check: ${url} answers (the bind address; the proxy is not checked)`,
    ]);
  });

  it.each([
    ['an nginx install', DEFAULT, 'health check: port 4321 answers, then http://cockpit.example.com/ (HTTP, the site has no TLS) asks for a login and accepts a probe login'],
    ['an --external-proxy install', { instance: 'api', port: 4400, externalProxy: true }, 'health check: http://127.0.0.1:4400/ answers (the bind address; the proxy is not checked)'],
  ])('plans nothing for %s that already uses the new names', async (_case, spec, health) => {
    const { f } = install(spec);
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    const migrated = loadServerState(spec.instance, f.target);
    await expect(migrateUbuntu(context(f, migrated, { dryRun: true }))).resolves.toEqual({ moved: [], leftAloneForeign: [], errors: [], details: [health] });
  });

  it('reports an already migrated install whose site file is gone', async () => {
    const { f } = install(DEFAULT);
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    const migrated = loadServerState('default', f.target);
    f.host.shell('rm -f /etc/nginx/sites-available/hearsay-squawk');
    await expect(migrateUbuntu(context(f, migrated, { dryRun: true }))).resolves.toEqual({ moved: [], leftAloneForeign: [], details: [],
      errors: [{ artifact: unitRecord(migrated), message: 'Cannot read /etc/nginx/sites-available/hearsay-squawk' }] });
  });

  type Message = string | ((f: ServerFixture) => string);
  type Refusal = [string, InstanceSpec, (f: ServerFixture, state: ServerState) => Record<string, string> | undefined, Message];
  it.each<Refusal>([
    ['no autostart record', DEFAULT, (_f, s) => { delete s.steps.autostart; }, 'No recorded autostart unit'],
    ['a skipped autostart step', DEFAULT, (_f, s) => { s.steps.autostart = { status: skipped, created: null }; }, 'No recorded autostart unit'],
    ['the unit of another instance', DEFAULT, (_f, s) => { unitRecord(s).name = 'cezar-shop.service'; }, 'Unexpected unit name: cezar-shop.service'],
    ['a unit record without a path', DEFAULT, (_f, s) => { delete unitRecord(s).path; }, 'No recorded unit path for cezar.service'],
    ['a unit record without a scope', DEFAULT, (_f, s) => { delete unitRecord(s).scope; }, 'No recorded unit path for cezar.service'],
    ['a system unit file that is gone', SHOP, f => { f.host.shell('rm -f /etc/systemd/system/cezar-shop.service'); }, 'Cannot read /etc/systemd/system/cezar-shop.service'],
    ['a user unit file with the new name', DEFAULT, f => ({ [userUnit(f, 'hearsay-squawk.service')]: 'operator unit\n' }),
      f => `Destination already exists: ${userUnit(f, 'hearsay-squawk.service')}`],
    ['an older backup of the old unit', DEFAULT, f => ({ [`${userUnit(f, 'cezar.service')}.migrated`]: 'older backup\n' }),
      f => `Destination already exists: ${userUnit(f, 'cezar.service')}.migrated`],
    ['a system unit file with the new name', SHOP, () => ({ '/etc/systemd/system/hearsay-squawk-shop.service': 'operator unit\n' }),
      'Destination already exists: /etc/systemd/system/hearsay-squawk-shop.service'],
    ['an htpasswd with the new name', DEFAULT, () => ({ '/etc/hearsay-squawk/htpasswd': 'ops:other\n' }), 'Destination already exists: /etc/hearsay-squawk/htpasswd'],
    ['a site that reads another htpasswd', DEFAULT, f => {
      f.host.write('/etc/nginx/sites-available/cezar', f.host.read('/etc/nginx/sites-available/cezar').replace('/etc/cezar/htpasswd', '/etc/nginx/.htpasswd'));
    }, 'The site does not read /etc/cezar/htpasswd'],
    ['no nginx record', DEFAULT, (_f, s) => { delete s.steps['nginx-proxy']; }, 'No recorded nginx-proxy step'],
  ])('changes nothing for %s', async (_case, spec, arrange, message) => {
    const { f, state } = install(spec);
    const planted = arrange(f, state) ?? {};
    for (const [path, content] of Object.entries(planted)) f.host.write(path, content);
    const ctx = context(f, state);
    const artifact = state.steps.autostart?.created ? unitRecord(state) : { kind: 'owned', type: 'service', name: 'hearsay-squawk.service' };
    await expect(migrateUbuntu(ctx)).resolves.toEqual({ moved: [], leftAloneForeign: [], errors: [{ artifact, message: typeof message === 'string' ? message : message(f) }] });
    expect(f.host.commands).toEqual([]);
    for (const [path, content] of Object.entries(planted)) expect(f.host.read(path)).toBe(content);
    const scope = spec.scope ?? 'user';
    expect(existsSync(f.host.unitFile(scope, spec.instance === 'shop' ? 'hearsay-squawk-shop.service' : 'hearsay-squawk.service')))
      .toBe(Object.keys(planted).some(path => path.endsWith('.service')));
  });

  it('finds the unit record in a ledger edited to list the linger record first', async () => {
    const { f, state } = install(DEFAULT);
    const [unitMove] = defaultMoves(f, state);
    state.steps.autostart!.created!.artifacts.unshift({ kind: 'owned', type: 'linger', name: 'ops' });
    const report = await migrateUbuntu(context(f, state, { dryRun: true }));
    expect(report).toMatchObject({ errors: [] });
    expect(report.moved[0]).toEqual(unitMove);
  });

  it('points every auth_basic_user_file of the copied site at the new htpasswd', async () => {
    const { f, state } = install(DEFAULT);
    const site = f.host.read('/etc/nginx/sites-available/cezar');
    f.host.write('/etc/nginx/sites-available/cezar', site.replace('    location / {', '    location /api/ {\n        auth_basic_user_file /etc/cezar/htpasswd;\n    }\n\n    location / {'));
    await expect(migrateUbuntu(context(f, state))).resolves.toMatchObject({ errors: [] });
    const copied = f.host.read('/etc/nginx/sites-available/hearsay-squawk');
    expect(copied).not.toContain('/etc/cezar/htpasswd');
    expect(copied.match(/auth_basic_user_file \/etc\/hearsay-squawk\/htpasswd;/g)).toHaveLength(2);
  });

  it.each<[string, InstanceSpec, (f: ServerFixture) => void, string[], 'unit' | 'site']>([
    ['systemd does not enable the new user unit', DEFAULT,
      f => { f.host.failing = w => w.join(' ') === 'systemctl --user enable hearsay-squawk.service'; }, ['cezar'], 'unit'],
    ['the old system unit does not disable', SHOP, f => { f.host.failDisable.add('cezar-shop.service'); }, ['cezar-shop'], 'unit'],
    ['nginx rejects the copied site', DEFAULT, f => { f.host.nginxTestFailures = 1; }, ['hearsay-squawk'], 'site'],
  ])('stops at the first failed move when %s', async (_case, spec, arrange, sites, failed) => {
    const { f, state } = install(spec);
    arrange(f);
    const report = await migrateUbuntu(context(f, state));
    expect({ moved: report.moved.map(m => m.stepId), errors: report.errors }).toEqual(failed === 'unit'
      ? { moved: [], errors: [{ artifact: unitRecord(state), message: expect.any(String) }] }
      : { moved: ['autostart'], errors: [{ artifact: siteRecords(state)[0], message: expect.any(String) }] });
    expect(f.host.enabledSites()).toEqual(sites);
  });

  it('never overwrites a unit file that appears after planning', async () => {
    const { f, state } = install(DEFAULT);
    const target = userUnit(f, 'hearsay-squawk.service');
    const capture = f.host.capture.bind(f.host);
    f.host.capture = async (program, args, opts) => {
      if (program === 'test' && !existsSync(target)) writeFileSync(target, 'written by another process\n');
      return capture(program, args, opts);
    };
    const report = await migrateUbuntu(context(f, state));
    expect(report).toMatchObject({ moved: [], errors: [{ artifact: unitRecord(state) }] });
    expect(readFileSync(target, 'utf8')).toBe('written by another process\n');
    expect(f.host.unit('user', 'cezar.service')).toMatchObject({ enabled: true, active: true });
  });

  it('records the new site paths when the install recorded no nginx artifacts', async () => {
    const { f, state } = install(DEFAULT);
    Home.seed(f.legacy, f.legacy.serverState('default'), { ...state, steps: { ...state.steps, 'nginx-proxy': { status: done, created: null } } });
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    expect(siteRecords(loadServerState('default', f.target))).toEqual([
      { kind: 'owned', type: 'file', path: '/etc/nginx/sites-available/hearsay-squawk' },
      { kind: 'owned', type: 'symlink', path: '/etc/nginx/sites-enabled/hearsay-squawk' },
      { kind: 'owned', type: 'htpasswd', path: '/etc/hearsay-squawk/htpasswd' },
    ]);
    expect(f.host.enabledSites()).toEqual(['hearsay-squawk']);
  });
});

describe('root commands the operator runs (delegate mode)', () => {
  const delegate = (f: ServerFixture, state: ServerState, runsCommands: boolean, read: string[] = []) =>
    context(f, state, { assumeYes: false, prefs: { sudoMode: 'delegate' }, ui: operatorUi(f, runsCommands, read) });

  it('completes the system unit and site move, and its rollback, when the operator runs each command', async () => {
    const { f, state } = install(SHOP);
    const report = await migrateUbuntu(delegate(f, state, true));
    expect(report).toMatchObject({ errors: [] });
    expect(report.moved).toHaveLength(4);
    expect(f.host.unit('system', 'hearsay-squawk-shop.service').enabled).toBe(true);
    expect(f.host.enabledSites()).toEqual(['hearsay-squawk-shop']);
    const read: string[] = [];
    await expect(rollbackUbuntuMigration(delegate(f, state, true, read), report)).resolves.toMatchObject({ errors: [] });
    // The operator runs the restore as root: its prompt names the unit it removes and the one it restores.
    expect(read.some(line => line.includes('hearsay-squawk-shop.service') && line.includes('cezar-shop.service'))).toBe(true);
    expect(f.host.unit('system', 'cezar-shop.service').enabled).toBe(true);
    expect(f.host.exists('/etc/systemd/system/hearsay-squawk-shop.service')).toBe(false);
    expect(f.host.enabledSites()).toEqual(['cezar-shop']);
  });

  it('reports no move when the operator confirms a command that did not run', async () => {
    const { f, state } = install(SHOP);
    await expect(migrateUbuntu(delegate(f, state, false))).resolves.toMatchObject({ moved: [], errors: [{ artifact: unitRecord(state) }] });
    expect(f.host.unit('system', 'cezar-shop.service')).toMatchObject({ enabled: true, active: true });
  });
});

describe('ubuntu-vps rollback refusals', () => {
  type Edit = [string, (f: ServerFixture, moves: Move[]) => { entry: StepArtifact; victim?: string }];
  it.each<Edit>([
    ['a unit entry renamed to another unit', (_f, [unit]) => {
      unit!.to.name = 'sshd.service';
      return { entry: unit!.to, victim: unit!.to.path! };
    }],
    ['a unit entry whose new file is another unit', (f, [unit]) => {
      unit!.to.path = userUnit(f, 'sshd.service');
      f.host.write(unit!.to.path, 'operator unit\n');
      return { entry: unit!.to, victim: unit!.to.path };
    }],
    ['a unit entry whose backup is another file', (f, [unit]) => {
      unit!.backup = { kind: 'owned', type: 'file', path: userUnit(f, 'other.service') };
      f.host.write(unit!.backup.path!, 'operator unit\n');
      return { entry: unit!.to, victim: unit!.backup.path! };
    }],
    ['a unit entry without its backup', (_f, [unit]) => {
      delete unit!.backup;
      return { entry: unit!.to };
    }],
    ['a unit entry without a path', (_f, [unit]) => {
      delete unit!.to.path;
      return { entry: unit!.to };
    }],
    ['a site entry that names the default nginx site', (f, [, available]) => {
      available!.to.path = '/etc/nginx/sites-available/default';
      f.host.write(available!.to.path, 'server {}\n');
      return { entry: available!.to, victim: available!.to.path };
    }],
  ])('refuses %s and leaves its files', async (_case, edit) => {
    const { f, state } = install(DEFAULT);
    const report = await migrateUbuntu(context(f, state));
    const moves = structuredClone(report.moved);
    const { entry, victim } = edit(f, moves);
    const content = victim ? f.host.read(victim) : undefined;
    const result = await rollbackUbuntuMigration(context(f, state), { ...report, moved: moves });
    expect(result.errors).toEqual([{ artifact: entry, message: `Invalid ubuntu-vps rollback entry: ${entry.path ?? entry.name}` }]);
    if (victim) expect(f.host.read(victim)).toBe(content);
  });

  it('restores an --external-proxy unit on a host without nginx', async () => {
    const { f, state } = install({ instance: 'api', port: 4400, domain: 'api.example.com', externalProxy: true });
    const report = await migrateUbuntu(context(f, state));
    f.host.failing = w => w[0] === 'nginx';
    await expect(rollbackUbuntuMigration(context(f, state), report)).resolves.toMatchObject({ errors: [] });
    expect(f.host.unit('user', 'cezar-api.service').enabled).toBe(true);
    expect(existsSync(userUnit(f, 'hearsay-squawk-api.service'))).toBe(false);
  });

  it.each<[string, (f: ServerFixture) => string | undefined, string | ((f: ServerFixture) => string)]>([
    ['the old unit file exists again next to its backup', f => {
      writeFileSync(userUnit(f, 'cezar.service'), 'restored by hand\n');
      return userUnit(f, 'cezar.service');
    }, f => `Both ${userUnit(f, 'cezar.service')} and its backup exist`],
    ['the new unit stays enabled after its process died', f => {
      f.host.unit('user', 'hearsay-squawk.service').active = false;
      f.host.failDisable.add('hearsay-squawk.service');
      return userUnit(f, 'hearsay-squawk.service');
    }, 'Could not stop and disable hearsay-squawk.service'],
    ['systemd does not enable the old unit', f => {
      f.host.failing = w => w.join(' ') === 'systemctl --user enable cezar.service';
      return undefined;
    }, 'Could not enable cezar.service'],
  ])('reports a user unit restore as failed when %s', async (_case, arrange, message) => {
    const { f, state } = install(DEFAULT);
    const report = await migrateUbuntu(context(f, state));
    const kept = arrange(f);
    const content = kept && readFileSync(kept, 'utf8');
    const result = await rollbackUbuntuMigration(context(f, state), report);
    expect(result.errors).toEqual([{ artifact: report.moved[0]!.to, message: typeof message === 'string' ? message : message(f) }]);
    if (kept) expect(readFileSync(kept, 'utf8')).toBe(content);
  });

  it.each<[string, (f: ServerFixture, state: ServerState) => Promise<PlatformMigrationReport>]>([
    ['the new unit keeps running', async (f, state) => {
      const report = await migrateUbuntu(context(f, state));
      f.host.unit('system', 'hearsay-squawk-shop.service').active = true;
      f.host.failDisable.add('hearsay-squawk-shop.service');
      return report;
    }],
    ['systemd does not enable the old unit', async (f, state) => {
      const report = await migrateUbuntu(context(f, state));
      f.host.failing = w => w.join(' ') === 'systemctl enable cezar-shop.service';
      return report;
    }],
    ['daemon-reload fails after a move that left the old unit enabled', async (f, state) => {
      const planned = await migrateUbuntu(context(f, state, { dryRun: true }));
      f.host.failDisable.add('cezar-shop.service');
      await expect(migrateUbuntu(context(f, state))).resolves.toMatchObject({ moved: [] });
      f.host.failing = w => w.join(' ') === 'systemctl daemon-reload';
      return planned;
    }],
  ])('reports a system unit restore as failed when %s', async (_case, arrange) => {
    const { f, state } = install(SHOP);
    const report = await arrange(f, state);
    const result = await rollbackUbuntuMigration(context(f, state), report);
    expect(result.errors).toEqual([{ artifact: report.moved[0]!.to, message: expect.any(String) }]);
  });

  it.each<[string, string, string[], string[]]>([
    ['the htpasswd entry', 'htpasswd', ['/etc/nginx/sites-available/hearsay-squawk', '/etc/nginx/sites-enabled/hearsay-squawk'], ['cezar']],
    ['the site file entry', 'file', ['/etc/nginx/sites-enabled/hearsay-squawk', '/etc/hearsay-squawk/htpasswd'], []],
  ])('a journal edited to drop %s restores only the files it still names', async (_case, dropped, removed, sites) => {
    const { f, state } = install(DEFAULT);
    const report = await migrateUbuntu(context(f, state));
    const kept = report.moved.find(m => m.from.type === dropped)!.to.path!;
    const edited = { ...report, moved: report.moved.filter(m => m.from.type !== dropped) };
    await expect(rollbackUbuntuMigration(context(f, state), edited)).resolves.toMatchObject({ errors: [] });
    for (const path of removed) expect(f.host.exists(path)).toBe(false);
    expect(f.host.exists(kept)).toBe(true);
    expect(f.host.enabledSites()).toEqual(sites);
  });
});

describe('ubuntu-vps service stop and health check', () => {
  const strategy = createUbuntuVps();

  it.each([
    ['user', DEFAULT, 'cezar.service'],
    ['system', SHOP, 'cezar-shop.service'],
  ] as const)('stopping fails while the %s unit keeps running', async (scope, spec, name) => {
    const { f, state } = install(spec);
    f.host.failing = w => w.includes('stop') && w.includes(name);
    await expect(strategy.stopService!(context(f, state))).rejects.toThrow(StepAborted);
    expect(f.host.unit(scope, name).active).toBe(true);
  });

  it('a restored install passes its check without a probe login', async () => {
    const { f, state } = install(DEFAULT);
    await strategy.stopService!(context(f, state));
    await expect(strategy.startService!(context(f, state))).resolves.toBeUndefined();
    expect(f.host.unit('user', 'cezar.service').active).toBe(true);
  });

  it.each<[string, (f: ServerFixture) => void, string]>([
    ['the login through the site does not reach Squawk', f => {
      f.host.write('/etc/nginx/sites-available/cezar', f.host.read('/etc/nginx/sites-available/cezar').replace('127.0.0.1:4321', '127.0.0.1:4999'));
      f.host.reloadNginx();
    }, 'http://cockpit.example.com/ refused the probe login (got 502)'],
    ['curl ends without output', f => { f.host.failing = w => w[0] === 'curl' && w.includes('--resolve'); }, 'http://cockpit.example.com/ did not ask for a login (got 000)'],
  ])('the probe-login check fails when %s', async (_case, arrange, message) => {
    const { f, state } = install(DEFAULT);
    arrange(f);
    await expect(strategy.startService!(context(f, state), { probeAuth: true })).rejects.toThrow(message);
    expect(f.host.read('/etc/cezar/htpasswd')).not.toContain('cez-migrate-probe');
  });
});
