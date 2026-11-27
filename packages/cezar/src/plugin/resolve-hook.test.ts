import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.doUnmock('node:module'); vi.resetModules(); });

it('names index.ts next to a source module and index.js next to a built one', async () => {
  const { runningPluginEntryUrl } = await import('./resolve-hook.ts');
  // Built from a native path, so the URLs carry a drive letter on Windows.
  const url = (...parts: string[]) => pathToFileURL(join(sep, ...parts)).href;
  expect(runningPluginEntryUrl(url('repo', 'src', 'plugin', 'resolve-hook.ts'))).toBe(url('repo', 'src', 'plugin', 'index.ts'));
  expect(runningPluginEntryUrl(url('lib', 'squawk', 'dist', 'plugin', 'resolve-hook.js'))).toBe(url('lib', 'squawk', 'dist', 'plugin', 'index.js'));
  expect(runningPluginEntryUrl()).toBe(new URL('./index.ts', import.meta.url).href);
});

it('registers the hook once per process and maps only the allowlisted plugin entries', async () => {
  vi.resetModules();
  const registerHooks = vi.fn();
  vi.doMock('node:module', async original => ({ ...await original<typeof import('node:module')>(), registerHooks }));
  const { installPluginResolveHook, runningPluginEntryUrl, PLUGIN_ENTRY_SUBPATHS } = await import('./resolve-hook.ts');
  installPluginResolveHook();
  installPluginResolveHook();
  expect(registerHooks).toHaveBeenCalledOnce();
  const { resolve } = registerHooks.mock.calls[0]![0] as { resolve: (specifier: string, context: object, next: (specifier: string, context: object) => unknown) => unknown };
  const next = vi.fn(() => ({ url: 'file:///next' }));
  for (const [specifier, stem] of Object.entries(PLUGIN_ENTRY_SUBPATHS)) {
    expect(resolve(specifier, {}, next)).toEqual({ url: runningPluginEntryUrl(undefined, stem), shortCircuit: true });
  }
  expect(next).not.toHaveBeenCalled();
  for (const other of ['@hearsay-tools/squawk', '@hearsay-tools/squawk/plugin/runner-kit', '@hearsay-tools/squawk/app-type']) {
    expect(() => resolve(other, {}, next)).toThrow(`Cannot import ${other}: a plugin imports Squawk only from @hearsay-tools/squawk/plugin (or its documented kit subpaths).`);
  }
  expect(next).not.toHaveBeenCalled();
  expect(resolve('@hearsay-tools/squawk-extra', {}, next)).toEqual({ url: 'file:///next' });
  expect(resolve('zod', {}, next)).toEqual({ url: 'file:///next' });
  expect(next).toHaveBeenCalledWith('zod', {});
});

it('gives a plugin outside the repository the running copy of @hearsay-tools/squawk/plugin and refuses unknown subpaths', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'hsq-hook-plugin-'));
  try {
    mkdirSync(join(outside, 'plugin'));
    writeFileSync(
      join(outside, 'plugin', 'index.mjs'),
      "export { productEnv, z } from '@hearsay-tools/squawk/plugin';\nexport { nativeMockPath, readNdjson } from '@hearsay-tools/squawk/plugin/runtime';\nexport { AcpEvents, AcpRpcError, AcpSession, AcpTransport } from '@hearsay-tools/squawk/plugin/acp';\n",
    );
    writeFileSync(join(outside, 'plugin', 'subpath.mjs'), "export * from '@hearsay-tools/squawk/plugin/runner-kit';\n");
    const hook = pathToFileURL(fileURLToPath(new URL('./resolve-hook.ts', import.meta.url))).href;
    const entry = pathToFileURL(fileURLToPath(new URL('./index.ts', import.meta.url))).href;
    const runtime = pathToFileURL(fileURLToPath(new URL('./runtime.ts', import.meta.url))).href;
    const acp = pathToFileURL(fileURLToPath(new URL('./acp.ts', import.meta.url))).href;
    const plugin = pathToFileURL(join(outside, 'plugin', 'index.mjs')).href;
    const subpath = pathToFileURL(join(outside, 'plugin', 'subpath.mjs')).href;
    const script = `
      const { installPluginResolveHook } = await import(${JSON.stringify(hook)});
      installPluginResolveHook();
      const fromPlugin = await import(${JSON.stringify(plugin)});
      const running = await import(${JSON.stringify(entry)});
      const runningRuntime = await import(${JSON.stringify(runtime)});
      const runningAcp = await import(${JSON.stringify(acp)});
      const parsed = fromPlugin.z.object({ id: fromPlugin.z.string() }).parse({ id: 'host-plugin' });
      const subpath = await import(${JSON.stringify(subpath)}).then(() => 'loaded', error => error.message);
      console.log(JSON.stringify({
        same: fromPlugin.productEnv === running.productEnv
          && fromPlugin.z === running.z
          && fromPlugin.readNdjson === runningRuntime.readNdjson
          && fromPlugin.nativeMockPath === runningRuntime.nativeMockPath
          && fromPlugin.AcpSession === runningAcp.AcpSession
          && fromPlugin.AcpTransport === runningAcp.AcpTransport
          && fromPlugin.AcpEvents === runningAcp.AcpEvents
          && fromPlugin.AcpRpcError === runningAcp.AcpRpcError,
        parsed,
        subpath,
      }));
    `;
    // bound: a cold tsx start loads the runner kit; the default test timeout is the hang guard.
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('../..', import.meta.url)) });
    expect(JSON.parse(stdout.trim())).toEqual({
      same: true,
      parsed: { id: 'host-plugin' },
      subpath: 'Cannot import @hearsay-tools/squawk/plugin/runner-kit: a plugin imports Squawk only from @hearsay-tools/squawk/plugin (or its documented kit subpaths).',
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
