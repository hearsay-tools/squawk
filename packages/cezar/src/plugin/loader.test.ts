import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;

beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'hsq-plugins-'));
  (globalThis as { pluginLoadOrder?: string[] }).pluginLoadOrder = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete (globalThis as { pluginLoadOrder?: string[] }).pluginLoadOrder;
});

function plugin(name: string, source: string, file = 'index.mjs'): string {
  const folder = join(dir, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, file), source);
  return folder;
}

/** A plugin that records its load and registers one subcommand per name. */
function commandPlugin(name: string, commands: string[] = [], tail = ''): string {
  const registrations = commands.map(command =>
    `api.registerCliCommand({ name: ${JSON.stringify(command)}, usage: [], parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'none', load: async () => async () => 0 });`).join('\n');
  return plugin(name, `export default async function setup(api) {\n  globalThis.pluginLoadOrder.push(${JSON.stringify(name)});\n${registrations}\n${tail}\n}\n`);
}

async function load() {
  const loader = await import('./loader.ts');
  const cli = await import('../core/cli-registry.ts');
  const warnings: string[] = [];
  const report = await loader.loadPluginFolder({ dir, source: 'host', warn: line => warnings.push(line) });
  cli.sealCliCommands();
  return { report, warnings, cli, loader };
}

const order = () => (globalThis as { pluginLoadOrder?: string[] }).pluginLoadOrder;

describe('loadPluginFolder', () => {
  it('loads nothing and warns nothing when <config>/plugins/ is absent', async () => {
    rmSync(dir, { recursive: true });
    const { report, warnings } = await load();
    expect(report).toEqual({ folders: [dir], loaded: [], failed: [] });
    expect(warnings).toEqual([]);
  });

  it('loads child folders in code-point order of name, ignores files and follows symlinked folders', async () => {
    for (const name of ['b', 'B', 'a', '_z', 'Ä']) commandPlugin(name);
    writeFileSync(join(dir, 'notes.txt'), 'not a plugin');
    const outside = mkdtempSync(join(tmpdir(), 'hsq-linked-plugin-'));
    try {
      writeFileSync(join(outside, 'index.mjs'), `export default () => { globalThis.pluginLoadOrder.push('linked'); };\n`);
      symlinkSync(outside, join(dir, 'linked'), 'dir');
      const { report, warnings } = await load();
      expect(order()).toEqual(['B', '_z', 'a', 'b', 'linked', 'Ä']);
      expect(report.loaded.map(entry => entry.name)).toEqual(['B', '_z', 'a', 'b', 'linked', 'Ä']);
      expect(report.loaded.every(entry => entry.source === 'host')).toBe(true);
      expect(report.loaded.find(entry => entry.name === 'linked')?.path).toBe(join(dir, 'linked'));
      expect(warnings).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('prefers index.mjs over index.js and accepts index.js alone', async () => {
    plugin('both', `export default () => { globalThis.pluginLoadOrder.push('mjs'); };\n`);
    writeFileSync(join(dir, 'both', 'index.js'), `export default () => { globalThis.pluginLoadOrder.push('js'); };\n`);
    writeFileSync(join(dir, 'both', 'package.json'), '{"type":"module"}');
    plugin('js-only', `export default () => { globalThis.pluginLoadOrder.push('js-only'); };\n`, 'index.js');
    writeFileSync(join(dir, 'js-only', 'package.json'), '{"type":"module"}');
    const { report } = await load();
    expect(order()).toEqual(['mjs', 'js-only']);
    expect(report.failed).toEqual([]);
  });

  it('commits a valid plugin and reports what it registered', async () => {
    commandPlugin('greeter', ['greet', 'wave']);
    const { report, cli } = await load();
    expect(report.loaded).toEqual([{
      name: 'greeter', source: 'host', path: join(dir, 'greeter'),
      contributions: { runners: [], agentTools: [], waitKinds: [], stepKinds: [], cliCommands: ['greet', 'wave'], removalSlots: 0, runLifecycleListeners: 0 },
    }]);
    expect(cli.cliCommand('greet')?.name).toBe('greet');
  });

  it.each([
    ['a folder without index.mjs or index.js', (name: string) => plugin(name, 'unused', 'readme.md'), 'missing index.mjs or index.js', 'missing-entry'],
    ['an entry without a default export', (name: string) => plugin(name, 'export const setup = () => {};\n'), 'index.mjs has no default-exported setup function', 'no-setup'],
    ['an entry whose default export is not a function', (name: string) => plugin(name, 'export default { setup() {} };\n'), 'index.mjs has no default-exported setup function', 'no-setup'],
    ['a setup that throws after registering', (name: string) => commandPlugin(name, ['partial'], "throw new Error('setup broke');"), 'setup broke', 'setup'],
    ['a setup that rejects after registering', (name: string) => commandPlugin(name, ['partial'], "await Promise.resolve(); throw new Error('async setup broke');"), 'async setup broke', 'setup'],
    ['a setup that throws a value with no string form', (name: string) => commandPlugin(name, ['partial'], 'throw Object.create(null);'), 'a thrown value with no string form', 'setup'],
    ['an entry that does not import', (name: string) => plugin(name, 'export default (;\n'), '', 'import'],
  ])('skips %s with a warning, commits nothing and loads the next plugin', async (_case, write, reason, expectedReason) => {
    write('broken');
    commandPlugin('next', ['next-command']);
    const { report, warnings, cli } = await load();
    expect(report.loaded.map(entry => entry.name)).toEqual(['next']);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({ name: 'broken', source: 'host', path: join(dir, 'broken'), reason: expectedReason });
    expect(report.failed[0]!.error).toContain(reason);
    expect(warnings).toEqual([`[hsq] plugin "broken" skipped: ${report.failed[0]!.error}`]);
    expect(cli.hasCliCommand('partial')).toBe(false);
    expect(cli.hasCliCommand('next-command')).toBe(true);
  });

  it('rolls back a whole plugin whose key collides with an earlier plugin and keeps the earlier one', async () => {
    commandPlugin('a-first', ['shared']);
    commandPlugin('b-second', ['own', 'shared']);
    const { report, warnings, cli } = await load();
    expect(report.loaded.map(entry => entry.name)).toEqual(['a-first']);
    expect(report.failed.map(entry => entry.name)).toEqual(['b-second']);
    expect(report.failed[0]!.reason).toBe('setup');
    expect(report.failed[0]!.error).toContain("'shared'");
    expect(warnings[0]).toMatch(/^\[hsq\] plugin "b-second" skipped: .*'shared'/);
    expect(cli.hasCliCommand('shared')).toBe(true);
    expect(cli.hasCliCommand('own')).toBe(false);
  });

  it('rolls back a plugin that collides with a built-in command', async () => {
    const { registerBuiltInCliCommands } = await import('../built-in-cli-commands.ts');
    registerBuiltInCliCommands();
    commandPlugin('clash', ['extra', 'serve']);
    const { report, cli } = await load();
    expect(report.failed.map(entry => entry.name)).toEqual(['clash']);
    expect(report.failed[0]!.error).toContain("'serve'");
    expect(cli.hasCliCommand('extra')).toBe(false);
  });

  it('adds each folder to one process report', async () => {
    commandPlugin('one');
    const loader = await import('./loader.ts');
    await loader.loadPluginFolder({ dir, source: 'host', warn: () => {} });
    const empty = join(dir, 'missing');
    const report = await loader.loadPluginFolder({ dir: empty, source: 'bundled', warn: () => {} });
    expect(report.folders).toEqual([dir, empty]);
    expect(loader.pluginLoadReport()).toBe(report);
    expect(Object.isFrozen(report.loaded)).toBe(true);
  });
});

describe('pluginHealth', () => {
  const none = { runners: [], agentTools: [], waitKinds: [], stepKinds: [], cliCommands: [], removalSlots: 0, runLifecycleListeners: 0 };
  const failure = (name: string, reason: 'missing-entry' | 'no-setup' | 'import' | 'setup', error: string) =>
    ({ name, source: 'host' as const, path: `/srv/My Plugins/${name}`, reason, error });
  const report = {
    folders: ['/srv/My Plugins'],
    loaded: [{ name: 'good', source: 'host' as const, path: '/srv/My Plugins/good', contributions: none }],
    failed: [
      failure('no-entry', 'missing-entry', 'missing index.mjs or index.js'),
      failure('no-setup', 'no-setup', 'index.mjs has no default-exported setup function'),
      failure('bad-import', 'import', "Cannot find module '/srv/My Plugins/bad-import/dep.mjs' imported from \\\\fileserver\\users\\alice\\index.mjs"),
      failure('leaky', 'setup', 'request failed: token=sk-secret-123'),
    ],
  };
  const texts = {
    'no-entry': 'missing index.mjs or index.js',
    'no-setup': 'the entry has no default-exported setup function',
    'bad-import': 'the entry failed to import; run `hsq plugins` on the host for the error',
    leaky: 'setup failed or a registration was refused; run `hsq plugins` on the host for the error',
  };

  it('sends folders and the fixed text for each reason to a local cockpit, never the plugin message', async () => {
    const { pluginHealth } = await import('./loader.ts');
    const health = pluginHealth(report, { hostPaths: true });
    expect(health.loaded).toEqual([{ name: 'good', source: 'host', path: '/srv/My Plugins/good' }]);
    expect(health.failed).toEqual(report.failed.map(({ name, path }) => ({ name, source: 'host', path, error: texts[name as keyof typeof texts] })));
    expect(JSON.stringify(health)).not.toContain('sk-secret');
  });

  it('sends no path and no plugin message in hosted mode', async () => {
    const { pluginHealth } = await import('./loader.ts');
    const health = pluginHealth(report, { hostPaths: false });
    expect(health.loaded).toEqual([{ name: 'good', source: 'host' }]);
    expect(health.failed).toEqual(report.failed.map(({ name }) => ({ name, source: 'host', error: texts[name as keyof typeof texts] })));
    expect(JSON.stringify(health)).not.toMatch(/My Plugins|fileserver|sk-secret/);
  });
});

describe('loadBundledRunners', () => {
  /** A bundled runner folder: an entry that declares `order` and records its load. */
  function bundled(name: string, order: number, body = '', file = 'index.mjs'): void {
    plugin(name, `export const displayOrder = ${order};\nexport default async function setup(api) {\n  globalThis.pluginLoadOrder.push(${JSON.stringify(name)});\n${body}\n}\n`, file);
  }

  it('loads the bundled runners in display order, skips a folder with no entry and reports them as bundled', async () => {
    bundled('zeta', 10);
    bundled('alpha', 20);
    mkdirSync(join(dir, 'fixture'));
    writeFileSync(join(dir, 'fixture', 'definition.testkit.ts'), 'export {};\n');
    const loader = await import('./loader.ts');
    const report = await loader.loadBundledRunners(dir);
    expect(order()).toEqual(['zeta', 'alpha']);
    expect(report).toMatchObject({ folders: [dir], loaded: [{ name: 'zeta', source: 'bundled', path: join(dir, 'zeta') }, { name: 'alpha', source: 'bundled' }], failed: [] });
    expect(loader.pluginLoadReport()).toBe(report);
  });

  it('commits what a bundled runner registers, through the same setup as a host plugin', async () => {
    bundled('one', 10, "  api.registerCliCommand({ name: 'bundled-cmd', usage: [], parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'none', load: async () => async () => 0 });");
    const loader = await import('./loader.ts');
    const report = await loader.loadBundledRunners(dir);
    const cli = await import('../core/cli-registry.ts');
    cli.sealCliCommands();
    expect(cli.cliCommand('bundled-cmd')?.name).toBe('bundled-cmd');
    expect(report.loaded[0]?.contributions.cliCommands).toEqual(['bundled-cmd']);
  });

  it.each([
    ['setup throws', "  throw new Error('broken setup');", /Bundled runner "one" failed to load: broken setup/],
    ['import fails', "  missing(;", /Bundled runner "one" failed to load:/],
  ])('throws when a bundled runner fails (%s) and commits nothing of it', async (_case, body, message) => {
    bundled('one', 10, `  api.registerCliCommand({ name: 'half', usage: [], parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'none', load: async () => async () => 0 });\n${body}`);
    const loader = await import('./loader.ts');
    await expect(loader.loadBundledRunners(dir)).rejects.toThrow(message);
    expect(loader.pluginLoadReport().loaded).toEqual([]);
    const cli = await import('../core/cli-registry.ts');
    cli.sealCliCommands();
    expect(cli.cliCommand('half')).toBeUndefined();
  });

  it('throws when the folder holds no bundled runner, instead of booting with none', async () => {
    mkdirSync(join(dir, 'fixture'));
    const loader = await import('./loader.ts');
    await expect(loader.loadBundledRunners(dir)).rejects.toThrow(`No bundled runner was found in ${dir}`);
    expect(loader.pluginLoadReport().folders).toEqual([]);
  });

  it('loads no bundled runner when allowEmpty is set for a test override', async () => {
    const loader = await import('./loader.ts');
    const report = await loader.loadBundledRunners(dir, { allowEmpty: true });
    expect(report).toEqual({ folders: [dir], loaded: [], failed: [] });
    expect(loader.pluginLoadReport()).toBe(report);
  });

  it('throws when an entry has no default-exported setup', async () => {
    plugin('one', 'export const displayOrder = 10;\n');
    const loader = await import('./loader.ts');
    await expect(loader.loadBundledRunners(dir)).rejects.toThrow(/Bundled runner "one" failed to load: index\.mjs has no default-exported setup function/);
  });
});
