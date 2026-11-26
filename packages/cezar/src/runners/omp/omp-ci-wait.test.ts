import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const extensionUrl = new URL('./omp-ci-wait.mjs', import.meta.url);

function loadExtension(env: Record<string, string | undefined>): { status: number | null; stdout: string; stderr: string } {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.HSQ_TOOL_CLIENT;
  delete childEnv.CEZ_TOOL_CLIENT;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  const source = `
    import register from ${JSON.stringify(extensionUrl.href)};
    const tools = [];
    await register({ registerTool(tool) { tools.push(tool); } });
    process.stdout.write(JSON.stringify(tools));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
    env: childEnv,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('omp ci-wait extension (hearsay-tools/squawk#4260)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-omp-ci-wait-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function writeFile(relPath: string, content: string): string {
    const file = join(root, relPath);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
    return pathToFileURL(file).href;
  }

  it('loads registerRemoteSquawkTools directly from HSQ_TOOL_CLIENT and falls back to CEZ_TOOL_CLIENT', () => {
    const builtUrl = writeFile(
      'dist/ci-wait/client.js',
      'export async function registerRemoteSquawkTools(host) { host.registerTool({ name: "built-direct" }); }\n',
    );
    const legacyUrl = writeFile(
      'legacy/ci-wait/client.js',
      'export async function registerRemoteSquawkTools(host) { host.registerTool({ name: "legacy-direct" }); }\n',
    );

    const direct = loadExtension({ HSQ_TOOL_CLIENT: builtUrl });
    expect(direct.status).toBe(0);
    expect(direct.stderr).toBe('');
    expect(JSON.parse(direct.stdout)).toEqual([{ name: 'built-direct' }]);

    const legacy = loadExtension({ CEZ_TOOL_CLIENT: legacyUrl });
    expect(legacy.status).toBe(0);
    expect(JSON.parse(legacy.stdout)).toEqual([{ name: 'legacy-direct' }]);
  });

  it('throws a clear error when neither HSQ_TOOL_CLIENT nor CEZ_TOOL_CLIENT is set', () => {
    const result = loadExtension({});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('HSQ_TOOL_CLIENT is not set');
  });

  it('falls back to ../../dist/ci-wait/client.js relative to HSQ_TOOL_CLIENT when importing client.ts fails and built client exists', () => {
    const sourceUrl = writeFile(
      'src/ci-wait/client.ts',
      "import '@nonexistent-squawk-test/workspace-contract';\nexport const registerRemoteSquawkTools = async () => {};\n",
    );
    writeFile(
      'dist/ci-wait/client.js',
      'export async function registerRemoteSquawkTools(host) { host.registerTool({ name: "built-fallback" }); }\n',
    );

    const result = loadExtension({ HSQ_TOOL_CLIENT: sourceUrl });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ name: 'built-fallback' }]);
    expect(result.stderr).toContain('Squawk: loading built Squawk tools from dist/; rebuild after changing src/ci-wait');
  });

  it('rethrows the original source error when importing client.ts fails and built dist/ci-wait/client.js is absent', () => {
    const sourceUrl = writeFile(
      'src/ci-wait/client.ts',
      "throw new Error('source-checkout-import-failed');\n",
    );

    const result = loadExtension({ HSQ_TOOL_CLIENT: sourceUrl });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('source-checkout-import-failed');
    expect(result.stderr).not.toContain('loading built Squawk tools from dist/');
  });

  it('does not attempt fallback when HSQ_TOOL_CLIENT already points to a failing built client.js', () => {
    const builtUrl = writeFile(
      'dist/ci-wait/client.js',
      "throw new Error('built-client-broken');\n",
    );

    const result = loadExtension({ HSQ_TOOL_CLIENT: builtUrl });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('built-client-broken');
    expect(result.stderr).not.toContain('loading built Squawk tools from dist/');
  });
});
