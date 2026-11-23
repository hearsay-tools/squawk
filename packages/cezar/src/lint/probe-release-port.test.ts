import '../built-in-wait-kinds.testkit.ts';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitSync } from '../git-command.ts';
import { ruleCases } from './ast-rule.testkit.ts';
import { repoRoot } from './source-rule.ts';
import { oxlintBin } from './run.ts';
import { probeReleasePort } from './probe-release-port.ts';

ruleCases(probeReleasePort, {
  file: 'packages/cezar/src/probe.test.ts',
  invalid: [
    `async function freePort() {
      const server = createServer();
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      await new Promise(resolve => server.close(resolve));
      return port;
    }`,
    `function freePort() {
      return new Promise(done => {
        const probe = createServer();
        probe.listen(0, '127.0.0.1', () => {
          const port = probe.address().port;
          probe.close(() => done(port));
        });
      });
    }`,
    `async function freePort() {
      const probe = createServer().listen(0);
      const bound = probe.address();
      const port = bound ? bound.port : 0;
      await new Promise(resolve => probe.close(resolve));
      return port;
    }`,

  ],
  valid: [
    `const server = createServer(handler);
     server.listen(0, '127.0.0.1', () => announce(server.address().port));`,
    `async function check() {
      const server = createServer();
      server.listen(0);
      const { port } = server.address();
      await request(port);
      server.close();
    }`,
    `// probe.listen(0); const { port } = probe.address(); probe.close(); return port;`,
    `function usedListener() {
      const server = createServer(); server.listen(0);
      const { port } = server.address(); request(port); server.close();
    }
    function unrelated() { const port = 123; return port; }`,

  ],
});

// Run script roots through the real CLI so reasoned oxlint suppressions work here too.
describe('script port ownership', () => {
  it('keeps script listeners and honors oxlint suppressions', async () => {
    const files = gitSync(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'scripts', '.github/scripts', '.ai/scripts'], { cwd: repoRoot }).split('\0').filter(file => /\.[cm]?[jt]sx?$/.test(file));
    const dir = mkdtempSync(join(tmpdir(), 'squawk-port-lint-'));
    try {
      const config = JSON.parse(readFileSync(join(repoRoot, '.oxlintrc.json'), 'utf8'));
      const path = join(dir, 'oxlint.json');
      writeFileSync(path, JSON.stringify({ ...config, plugins: [], overrides: [],
        jsPlugins: [join(repoRoot, 'packages/cezar/src/lint/plugin.ts')],
        rules: { 'cez/probe-release-port': 'error' },
      }));
      // bound: one oxlint startup over the repository's script roots; a timeout only ends a hang.
      const result = await promisify(execFile)(process.execPath, [oxlintBin(), '-c', path, ...new Set(files)], {
        cwd: repoRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 << 20,
      });
      expect(result.stderr).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
