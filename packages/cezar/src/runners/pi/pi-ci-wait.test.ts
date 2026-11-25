import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const extensionUrl = new URL('./extensions/pi-ci-wait.mjs', import.meta.url);

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

describe('pi ci-wait extension (hearsay-tools/squawk#4260)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-pi-ci-wait-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function writeClient(relPath: string, tag: string): string {
    const file = join(root, relPath);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(
      file,
      `export async function registerRemoteSquawkTools(host) { host.registerTool({ name: ${JSON.stringify(tag)} }); }\n`,
    );
    return pathToFileURL(file).href;
  }

  it('loads registerRemoteSquawkTools from HSQ_TOOL_CLIENT', () => {
    const clientUrl = writeClient('dist/ci-wait/client.js', 'from-hsq');
    const result = loadExtension({ HSQ_TOOL_CLIENT: clientUrl });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ name: 'from-hsq' }]);
  });

  it('falls back to CEZ_TOOL_CLIENT when HSQ_TOOL_CLIENT is unset and prefers HSQ_TOOL_CLIENT when both are set', () => {
    const legacyUrl = writeClient('legacy/client.js', 'from-cez');
    const preferredUrl = writeClient('preferred/client.js', 'from-hsq');

    const fallback = loadExtension({ CEZ_TOOL_CLIENT: legacyUrl });
    expect(fallback.status).toBe(0);
    expect(JSON.parse(fallback.stdout)).toEqual([{ name: 'from-cez' }]);

    const preferred = loadExtension({ HSQ_TOOL_CLIENT: preferredUrl, CEZ_TOOL_CLIENT: legacyUrl });
    expect(preferred.status).toBe(0);
    expect(JSON.parse(preferred.stdout)).toEqual([{ name: 'from-hsq' }]);
  });

  it('throws a clear error when neither HSQ_TOOL_CLIENT nor CEZ_TOOL_CLIENT is set', () => {
    const result = loadExtension({});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('HSQ_TOOL_CLIENT is not set');
  });
});
