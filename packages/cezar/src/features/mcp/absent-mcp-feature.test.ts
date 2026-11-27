import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('bundled mcp feature registration and absent-feature boot (hearsay-tools/squawk#4401)', () => {
  let root: string;
  let emptyFeatures: string;
  let emptyHost: string;

  beforeEach(() => {
    vi.resetModules();
    root = mkdtempSync(join(tmpdir(), 'hsq-absent-mcp-'));
    emptyFeatures = mkdtempSync(join(root, 'features-'));
    emptyHost = mkdtempSync(join(root, 'host-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('registers mcp as a bundled plugin and lists it in hsq plugins and hsq --help', async () => {
    const { bootRuntime } = await import('../../boot.ts');
    await bootRuntime({ pluginsDir: emptyHost });

    const { pluginLoadReport } = await import('../../plugin/loader.ts');
    const { formatPluginReport } = await import('../../plugin/cli.ts');
    const report = pluginLoadReport();
    expect(report.failed).toEqual([]);
    const mcpPlugin = report.loaded.find((entry) => entry.name === 'mcp');
    expect(mcpPlugin).toBeDefined();
    expect(mcpPlugin?.source).toBe('bundled');
    expect(mcpPlugin?.contributions.cliCommands).toEqual(['mcp']);
    expect(mcpPlugin?.contributions.httpRoutes).toEqual(['mcp']);
    const { registeredHttpRoutes } = await import('../../core/http-route-registry.ts');
    expect(registeredHttpRoutes().map((route) => route.path)).toContain('/api/v1/mcp');

    const formatted = formatPluginReport(report);
    expect(formatted).toContain('mcp');

    const { testHome } = await import('../../home/test-home.testkit.ts');
    const { defaultCliDeps, main } = await import('../../cli-dispatch.ts');
    const log = vi.fn();
    const processStub = { argv: ['/bin/node', '/bin/hsq', '--help'], env: {}, cwd: () => root, exitCode: undefined as number | undefined };
    await main({
      ...defaultCliDeps,
      process: processStub as unknown as NodeJS.Process,
      console: { log, error: vi.fn(), warn: vi.fn() } as unknown as Console,
      resolveCliHome: () => testHome(),
      prepareOperatorHome: () => testHome(),
      getRepoInfo: vi.fn().mockResolvedValue(null),
      readOwnVersion: () => '0.0.0-test',
      serveCommand: vi.fn(),
      serverCommand: vi.fn(),
      runCommand: vi.fn(),
      initCommand: vi.fn(),
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('hsq mcp'));
  });

  it('boots cleanly when features/mcp/ is absent, omits mcp from plugins and help, and rejects hsq mcp as unknown command', async () => {
    const { bootRuntime } = await import('../../boot.ts');
    await bootRuntime({ bundledFeaturesDir: emptyFeatures, pluginsDir: emptyHost });

    const { pluginLoadReport } = await import('../../plugin/loader.ts');
    const { formatPluginReport } = await import('../../plugin/cli.ts');
    const report = pluginLoadReport();
    expect(report.failed).toEqual([]);
    expect(report.loaded.map((entry) => entry.name)).not.toContain('mcp');
    expect(formatPluginReport(report)).not.toMatch(/^\s+mcp\s+/m);
    const { registeredHttpRoutes } = await import('../../core/http-route-registry.ts');
    expect(registeredHttpRoutes().map((route) => route.path)).not.toContain('/api/v1/mcp');

    const { testHome } = await import('../../home/test-home.testkit.ts');
    const { defaultCliDeps, main } = await import('../../cli-dispatch.ts');
    const log = vi.fn();
    const error = vi.fn();
    const processStub = { argv: ['/bin/node', '/bin/hsq', 'mcp'], env: {}, cwd: () => root, exitCode: undefined as number | undefined };
    await main({
      ...defaultCliDeps,
      process: processStub as unknown as NodeJS.Process,
      console: { log, error, warn: vi.fn() } as unknown as Console,
      resolveCliHome: () => testHome(),
      prepareOperatorHome: () => testHome(),
      getRepoInfo: vi.fn().mockResolvedValue(null),
      readOwnVersion: () => '0.0.0-test',
      serveCommand: vi.fn(),
      serverCommand: vi.fn(),
      runCommand: vi.fn(),
      initCommand: vi.fn(),
    });
    expect(processStub.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unknown command: mcp'));
    expect(log).toHaveBeenCalledWith(expect.not.stringContaining('hsq mcp'));
  });
});
