import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

// bound: nested Vitest processes load the real setups; this is a host-load hang guard.
it.each(['cezar', 'web'])('%s workers isolate inherited home paths before a test loads', { timeout: 120_000 }, project => {
  const qa = join(repo, '.ai/qa');
  mkdirSync(qa, { recursive: true });
  const scratch = mkdtempSync(join(qa, 'home-runner-'));
  try {
    const fixture = join(scratch, 'isolation.test.ts');
    writeFileSync(fixture, `
import { beforeAll, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, join, relative, isAbsolute } from 'node:path';
${project === 'cezar' ? `
const agentHomeKeys = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR', 'OMP_PROFILE', 'PI_PROFILE'];
const sandbox = process.env.HOME;
for (const key of ['CEZ_TEST_INHERITED_SENTINEL', 'CEZ_PREVIEW', 'CEZ_PROJECT_WARMUP']) expect(process.env[key], key).toBeUndefined();
expect(basename(process.env.CEZ_HOME!)).toMatch(/^cez-vitest-home-/);
expect(process.env.UNIT_ENV_SENTINEL).toBe('preserved');
beforeAll(() => { process.env.CEZ_DRY_RUN = 'from-beforeAll'; });
` : ''}
it('loads one pinned test home', () => {
  const home = process.env.HOME!;
  expect(home).not.toBe('/host/user');
  expect(process.env.USERPROFILE).toBe(home);
  expect(process.env.CEZ_TASK_ID).toBeUndefined();
  expect(process.env.CEZ_REMOTE).toBeUndefined();
  expect(process.env.XDG_RUNTIME_DIR).toBeUndefined();
  expect(relative(home, process.env.CEZ_HOME!).startsWith('..')).toBe(false);
  expect(JSON.parse(readFileSync(join(process.env.CEZ_HOME!, 'install.json'), 'utf8')).kind).toBe('test');
  for (const [key, suffix] of Object.entries({ XDG_CONFIG_HOME: '.config', XDG_DATA_HOME: '.local/share',
    XDG_STATE_HOME: '.local/state', XDG_CACHE_HOME: '.cache' })) {
    expect(process.env[key]).toBe(join(home, suffix));
    expect(process.env[key]).not.toBe('/host/' + key);
    expect(isAbsolute(relative(home, process.env[key]!))).toBe(false);
    expect(relative(home, process.env[key]!).startsWith('..')).toBe(false);
  }
${project === 'cezar' ? `
  expect(process.env.CEZ_DRY_RUN).toBe('from-beforeAll');
  process.env.CEZ_PREVIEW = '1';
  expect(process.env.CEZ_PREVIEW).toBe('1');
  process.env.HOME = process.env.USERPROFILE = '/left/by/a/test';
  for (const key of agentHomeKeys) process.env[key] = '/left/by/a/test';
` : ''}
});
${project === 'cezar' ? `
// This whole fixture runs together; selecting an outer test cannot skip its setup scenario.
it('resets the homes and per-test flag while keeping the file flag', () => {
  expect(sandbox).toBeDefined();
  expect([process.env.HOME, process.env.USERPROFILE]).toEqual([sandbox, sandbox]);
  for (const key of agentHomeKeys) expect(process.env[key], key).toBeUndefined();
  expect(process.env.CEZ_DRY_RUN).toBe('from-beforeAll');
  expect(process.env.CEZ_PREVIEW).toBeUndefined();
});
` : ''}
`);
    const config = join(scratch, 'vitest.config.mjs');
    writeFileSync(config, `export default ${JSON.stringify({
      resolve: { alias: { '@': resolve(repo, 'packages/web/src') } },
      test: { environment: project === 'web' ? 'jsdom' : 'node', include: [fixture],
        setupFiles: [join(repo, `packages/${project}/vitest.setup.ts`)], maxWorkers: 1 },
    })}`);
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT']
      .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    const output = execFileSync(process.execPath, [join(repo, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config], {
      cwd: repo, encoding: 'utf8', timeout: 90_000, env: { ...env, HOME: '/host/user', USERPROFILE: '/host/user',
        CEZ_HOME: '/host/live', CEZ_TASK_ID: 'host-task', CEZ_REMOTE: '1', XDG_RUNTIME_DIR: '/host/run',
        ...(project === 'cezar' ? { CEZ_TEST_INHERITED_SENTINEL: 'inherited', CEZ_PREVIEW: '1',
          CEZ_PROJECT_WARMUP: '0', UNIT_ENV_SENTINEL: 'preserved' } : {}),
        ...Object.fromEntries(['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'].map(key => [key, '/host/' + key])) },
    });
    expect(output).toContain(project === 'cezar' ? '2 passed' : '1 passed');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

it('every node:test and browser entry loads the shared bootstrap', () => {
  const read = (path: string) => readFileSync(join(repo, path), 'utf8');
  for (const manifest of ['package.json', 'packages/cezar/package.json']) {
    expect(JSON.parse(read(manifest)).scripts['test:unit']).toMatch(/--import (?:\.\.\/\.\.\/|\.\/)scripts\/test-home-env\.mjs/);
  }
  expect(read('scripts/test-package.mjs')).toContain("'--import', '../../scripts/test-home-env.mjs'");
  for (const project of JSON.parse(read('squeal.config.json')).nodeTest as Array<{ argv: string[] }>) {
    expect(project.argv.some(arg => arg.endsWith('/scripts/test-home-env.mjs'))).toBe(true);
  }
  expect(read('packages/web/e2e/vitest.config.ts')).toContain("setupFiles: ['../../../scripts/test-browser-home-env.mjs'");
  for (const entry of ['scripts/test-home-env.mjs', 'scripts/test-browser-home-env.mjs',
    'packages/cezar/vitest.setup.ts', 'packages/web/vitest.setup.ts']) expect(read(entry)).toContain('configureTestHome');
  expect(JSON.parse(read('squeal.config.json')).inputs['packages/cezar/src/test-task-env.test.ts']).toEqual(
    expect.arrayContaining(['scripts/test-git-env.mjs', 'scripts/test-home-setup.mjs']));
});
