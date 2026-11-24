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
    ['a folder without index.mjs or index.js', (name: string) => plugin(name, 'unused', 'readme.md'), 'missing index.mjs or index.js'],
    ['an entry without a default export', (name: string) => plugin(name, 'export const setup = () => {};\n'), 'index.mjs has no default-exported setup function'],
    ['an entry whose default export is not a function', (name: string) => plugin(name, 'export default { setup() {} };\n'), 'index.mjs has no default-exported setup function'],
    ['a setup that throws after registering', (name: string) => commandPlugin(name, ['partial'], "throw new Error('setup broke');"), 'setup broke'],
    ['a setup that rejects after registering', (name: string) => commandPlugin(name, ['partial'], "await Promise.resolve(); throw new Error('async setup broke');"), 'async setup broke'],
    ['an entry that does not import', (name: string) => plugin(name, 'export default (;\n'), ''],
  ])('skips %s with a warning, commits nothing and loads the next plugin', async (_case, write, reason) => {
    write('broken');
    commandPlugin('next', ['next-command']);
    const { report, warnings, cli } = await load();
    expect(report.loaded.map(entry => entry.name)).toEqual(['next']);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({ name: 'broken', source: 'host', path: join(dir, 'broken') });
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
  const report = {
    folders: ['/home/me/.config/squawk/plugins'],
    loaded: [{ name: 'good', source: 'host' as const, path: '/home/me/.config/squawk/plugins/good',
      contributions: { runners: [], agentTools: [], waitKinds: [], stepKinds: [], cliCommands: [], removalSlots: 0, runLifecycleListeners: 0 } }],
    failed: [{ name: 'bad', source: 'host' as const, path: '/home/me/.config/squawk/plugins/bad',
      error: "Cannot find module '/home/me/.config/squawk/plugins/bad/dep.mjs' imported from /home/me/.config/squawk/plugins/bad/index.mjs" }],
  };

  it('sends folders and full errors to a local cockpit', async () => {
    const { pluginHealth } = await import('./loader.ts');
    expect(pluginHealth(report, { hostPaths: true })).toEqual({
      loaded: [{ name: 'good', source: 'host', path: '/home/me/.config/squawk/plugins/good' }],
      failed: [{ name: 'bad', source: 'host', path: '/home/me/.config/squawk/plugins/bad', error: report.failed[0]!.error }],
    });
  });

  it('sends no host path in hosted mode', async () => {
    const { pluginHealth } = await import('./loader.ts');
    expect(pluginHealth(report, { hostPaths: false })).toEqual({
      loaded: [{ name: 'good', source: 'host' }],
      failed: [{ name: 'bad', source: 'host', error: "Cannot find module '<path>' imported from <path>" }],
    });
  });

  it.each([
    ['missing index.mjs or index.js', 'missing index.mjs or index.js'],
    ["CLI commands: conflicting registration for 'a/b'.", "CLI commands: conflicting registration for 'a/b'."],
    ['failed at file:///srv/x/index.mjs:3', 'failed at <path>'],
    ['open C:\\Users\\me\\plugins\\x', 'open <path>'],
    ['(/opt/plugins/x)', '(<path>)'],
    ["Cannot find module './secret/auth.mjs' imported from /cfg/plugins/x/index.mjs", "Cannot find module '<path>' imported from <path>"],
    ["Cannot find module '../shared/dep.mjs' imported from C:\\cfg\\plugins\\x\\index.mjs", "Cannot find module '<path>' imported from <path>"],
    ['version 1.2 of x.y failed', 'version 1.2 of x.y failed'],
  ])('strips host paths: %s', async (input, output) => {
    const { withoutHostPaths } = await import('./loader.ts');
    expect(withoutHostPaths(input)).toBe(output);
  });
});
