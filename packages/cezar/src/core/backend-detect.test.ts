import { productIdentity } from '../home/identity.ts';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { detectEnvironment, probeRunner } from './backend-detect.ts';
import { runnerDefinition } from './runner-registry.ts';
import '../core/register-all-runners.testkit.ts';

// DetectEnvironment probes every registered runner.

const probeOmp = () => probeRunner('omp', runnerDefinition('omp').detection);

// `productEnv` reads each HSQ_* name before its CEZ_* twin, so a test that sets or clears a CEZ_*
// setting also clears the twin, or a variable exported in the developer's shell wins.
const hsqTwins = (...ids: string[]) => ['HSQ_DRY_RUN', ...ids.map((id) => `HSQ_${id}_BIN`)];
const clearHsqTwins = (...ids: string[]) => { for (const key of hsqTwins(...ids)) vi.stubEnv(key, undefined); };

describe('probeOmp', () => {
  const saved = { dry: process.env.CEZ_DRY_RUN, omp: process.env.CEZ_OMP_BIN, pi: process.env.CEZ_PI_BIN };
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-probe-omp-'));
    delete process.env.CEZ_DRY_RUN;
    clearHsqTwins('OMP', 'PI');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const [key, value] of [['CEZ_DRY_RUN', saved.dry], ['CEZ_OMP_BIN', saved.omp], ['CEZ_PI_BIN', saved.pi]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('reports the mock as present under CEZ_DRY_RUN=1', async () => {
    process.env.CEZ_DRY_RUN = '1';
    await expect(probeOmp()).resolves.toEqual({ name: 'omp', available: true, version: `mock (${productIdentity().envPrefix}DRY_RUN=1)` });
  });

  it('reads the version from CEZ_OMP_BIN', async () => {
    const bin = join(root, 'omp');
    writeFileSync(bin, '#!/bin/sh\necho omp/18.4.11\n');
    chmodSync(bin, 0o755);
    process.env.CEZ_OMP_BIN = bin;
    await expect(probeOmp()).resolves.toMatchObject({ name: 'omp', available: true, version: 'omp/18.4.11' });
  });

  it('degrades to an optional-install hint when the binary is missing, and never spawns pi', async () => {
    const piMarker = join(root, 'pi-was-spawned');
    const pi = join(root, 'pi');
    writeFileSync(pi, `#!/bin/sh\ntouch ${piMarker}\necho 1.0.0\n`);
    chmodSync(pi, 0o755);
    process.env.CEZ_PI_BIN = pi;
    process.env.CEZ_OMP_BIN = join(root, 'nonexistent-omp');
    await expect(probeOmp()).resolves.toEqual({
      name: 'omp',
      available: false,
      hint: 'optional: install OMP (omp.sh) and run `omp login` to use the OMP runner',
    });
    expect(existsSync(piMarker)).toBe(false);
  });

  it('is one of the rows detectEnvironment reports', async () => {
    process.env.CEZ_DRY_RUN = '1';
    expect((await detectEnvironment()).find((row) => row.name === 'omp')).toMatchObject({ available: true });
  });
});

// hearsay-tools/cezarion#1042: codex and opencode were the only agent probes that still spawned
// their real CLI under CEZ_DRY_RUN=1, delaying every dry-run cockpit's banner by the slower of the two.
describe('detectEnvironment: codex and opencode probes', () => {
  const keys = ['CEZ_DRY_RUN', 'CEZ_CODEX_BIN', 'CEZ_OPENCODE_BIN', 'CEZ_CLAUDE_BIN', 'CEZ_PI_BIN', 'CEZ_OMP_BIN', 'PATH'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let root: string;

  /** A fake CLI that records that it ran, then prints a version. */
  const fakeCli = (name: string, version: string) => {
    const bin = join(root, name);
    writeFileSync(bin, `#!/bin/sh\ntouch ${join(root, `${name}-was-spawned`)}\necho ${version}\n`);
    chmodSync(bin, 0o755);
    return bin;
  };
  const spawned = (name: string) => existsSync(join(root, `${name}-was-spawned`));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-probe-agents-'));
    delete process.env.CEZ_DRY_RUN;
    clearHsqTwins('CODEX', 'OPENCODE', 'CLAUDE', 'PI', 'OMP');
    process.env.CEZ_CODEX_BIN = fakeCli('codex', 'codex-cli 9.9.9');
    process.env.CEZ_OPENCODE_BIN = fakeCli('opencode', '8.8.8');
    // Keep the other agent probes off the host's real CLIs.
    for (const key of ['CEZ_CLAUDE_BIN', 'CEZ_PI_BIN', 'CEZ_OMP_BIN'] as const) {
      process.env[key] = join(root, 'absent');
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('reports one check for every runner, then gh and git', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const rows = await detectEnvironment();
    expect(rows.map((row) => row.name)).toEqual([...RUNNER_IDS, 'gh', 'git']);
  });

  it('spawns neither CLI under CEZ_DRY_RUN=1 and reports both mocks present', async () => {
    process.env.CEZ_DRY_RUN = '1';
    // No override: the fakes are what `codex` and `opencode` would resolve to on PATH.
    delete process.env.CEZ_CODEX_BIN;
    delete process.env.CEZ_OPENCODE_BIN;
    process.env.PATH = `${root}:${saved.PATH ?? ''}`;
    const rows = await detectEnvironment();
    expect(spawned('codex')).toBe(false);
    expect(spawned('opencode')).toBe(false);
    expect(rows.find((row) => row.name === 'codex')).toEqual({ name: 'codex', available: true, version: `mock (${productIdentity().envPrefix}DRY_RUN=1)` });
    expect(rows.find((row) => row.name === 'opencode')).toEqual({ name: 'opencode', available: true, version: `mock (${productIdentity().envPrefix}DRY_RUN=1)` });
  });

  // The runners resolve CEZ_*_BIN before the bundled mock, so an override is what a
  // dry-run task would start, and the probe must check it.
  it('probes an explicit CEZ_CODEX_BIN / CEZ_OPENCODE_BIN even under CEZ_DRY_RUN=1', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const rows = await detectEnvironment();
    expect(spawned('codex')).toBe(true);
    expect(spawned('opencode')).toBe(true);
    expect(rows.find((row) => row.name === 'codex')).toMatchObject({ available: true, version: 'codex-cli 9.9.9' });
    expect(rows.find((row) => row.name === 'opencode')).toMatchObject({ available: true, version: '8.8.8' });
  });

  it('reports a missing override as unavailable under CEZ_DRY_RUN=1', async () => {
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_CODEX_BIN = join(root, 'absent');
    process.env.CEZ_OPENCODE_BIN = join(root, 'absent');
    const rows = await detectEnvironment();
    expect(rows.find((row) => row.name === 'codex')).toMatchObject({ name: 'codex', available: false });
    expect(rows.find((row) => row.name === 'opencode')).toMatchObject({ name: 'opencode', available: false });
  });

  it('still spawns both and reads the real version without dry-run', async () => {
    const rows = await detectEnvironment();
    expect(spawned('codex')).toBe(true);
    expect(spawned('opencode')).toBe(true);
    expect(rows.find((row) => row.name === 'codex')).toEqual({
      name: 'codex', available: true, version: 'codex-cli 9.9.9', hint: 'if not authenticated, run `codex` once and log in',
    });
    expect(rows.find((row) => row.name === 'opencode')).toEqual({
      name: 'opencode', available: true, version: '8.8.8', hint: 'if no provider is configured, run `opencode` once to set one up',
    });
  });

  it('still reports a missing CLI as an optional install without dry-run', async () => {
    process.env.CEZ_CODEX_BIN = join(root, 'absent');
    process.env.CEZ_OPENCODE_BIN = join(root, 'absent');
    const rows = await detectEnvironment();
    expect(rows.find((row) => row.name === 'codex')).toMatchObject({ name: 'codex', available: false });
    expect(rows.find((row) => row.name === 'opencode')).toMatchObject({ name: 'opencode', available: false });
  });
});

describe('probeRunner: the Claude version banner', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-probe-claude-'));
    clearHsqTwins('CLAUDE');
    for (const key of ['CEZ_DRY_RUN', 'CEZ_CLAUDE_BIN']) vi.stubEnv(key, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const probeClaude = (banner: string) => {
    const bin = join(root, 'claude');
    writeFileSync(bin, `#!/bin/sh\necho '${banner}'\n`);
    chmodSync(bin, 0o755);
    vi.stubEnv('CEZ_CLAUDE_BIN', bin);
    return probeRunner('claude', runnerDefinition('claude').detection);
  };

  it('accepts a binary that prints the Claude Code banner', async () => {
    await expect(probeClaude('2.1.0 (Claude Code)')).resolves.toEqual({
      name: 'claude', available: true, version: '2.1.0 (Claude Code)', hint: 'if not authenticated, run `claude` once and log in',
    });
  });

  it('refuses a binary whose version line is not a Claude banner', async () => {
    const check = await probeClaude('wrapper-tool unknown');
    expect(check).toMatchObject({ name: 'claude', available: false });
    expect(check.hint).toContain("doesn't look like Claude Code (got: wrapper-tool unknown)");
  });
});
