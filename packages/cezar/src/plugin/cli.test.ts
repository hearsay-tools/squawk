import { describe, expect, it, vi } from 'vitest';
import type { PluginLoadReport } from './loader.ts';

const none = { runners: [], agentTools: [], waitKinds: [], stepKinds: [], cliCommands: [], httpRoutes: [], removalSlots: 0, runLifecycleListeners: 0, launchParts: [] };
const report: PluginLoadReport = {
  folders: ['/squawk/dist/runners/', '/cfg/plugins'],
  loaded: [{ name: 'claude', source: 'bundled', path: '/squawk/dist/runners/claude', contributions: { ...none, runners: ['claude'] } }, { name: 'greeter', source: 'host', path: '/cfg/plugins/greeter', contributions: { ...none, cliCommands: ['greet'], runners: ['echo'], removalSlots: 1, launchParts: ['greeting', 'motd'] } }],
  failed: [{ name: 'broken', source: 'host', path: '/cfg/plugins/broken', reason: 'missing-entry', error: 'missing index.mjs or index.js' }],
};

vi.mock('./loader.ts', () => ({ pluginLoadReport: () => report }));

function out() {
  return { log: vi.fn(), error: vi.fn() } as unknown as Console & { log: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

describe('hsq plugins', () => {
  it('lists loaded plugins with what they add and skipped plugins with the reason', async () => {
    const { runPluginsCommand } = await import('./cli.ts');
    const console = out();
    expect(await runPluginsCommand([], {}, console)).toBe(0);
    expect(console.log.mock.calls[0]![0]).toBe([
      'Plugin folder: /squawk/dist/runners/',
      'Plugin folder: /cfg/plugins',
      '',
      'Loaded (2):',
      '  claude  bundled  /squawk/dist/runners/claude',
      '    runners: claude',
      '  greeter  host  /cfg/plugins/greeter',
      '    commands: greet',
      '    runners: echo',
      '    removal slots: 1',
      '    launch parts: greeting, motd',
      '',
      'Skipped (1):',
      '  broken  host  /cfg/plugins/broken',
      '    error: missing index.mjs or index.js',
    ].join('\n'));
  });

  it('prints the report as JSON', async () => {
    const { runPluginsCommand } = await import('./cli.ts');
    const console = out();
    expect(await runPluginsCommand(['--json'], {}, console)).toBe(0);
    expect(JSON.parse(console.log.mock.calls[0]![0] as string)).toEqual(report);
  });

  it('says when no folder was read and nothing loaded', async () => {
    const { formatPluginReport } = await import('./cli.ts');
    expect(formatPluginReport({ folders: [], loaded: [], failed: [] })).toBe('No plugin folder was read.\n\nLoaded (0):\n  none\n\nSkipped (0):\n  none');
  });

  it('prints usage for --help and refuses an unknown argument', async () => {
    const { runPluginsCommand } = await import('./cli.ts');
    const help = out();
    expect(await runPluginsCommand(['--help'], {}, help)).toBe(0);
    expect(help.log.mock.calls[0]![0]).toMatch(/^usage: \S+ plugins \[--json\]/);
    const wrong = out();
    expect(await runPluginsCommand(['--yaml'], {}, wrong)).toBe(1);
    expect(wrong.error.mock.calls[0]![0]).toMatch(/^unknown argument: --yaml/);
  });
});
