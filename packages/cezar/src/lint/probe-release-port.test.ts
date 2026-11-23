import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitSync } from '../git-command.ts';
import { checkRule, ruleCases } from './ast-rule.testkit.ts';
import { repoRoot } from './source-rule.ts';
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

// Oxlint's normal package scan does not include these script roots. Use the same
// visitors here so new script helpers get the same regression guard.
describe('script port ownership', () => {
  const files = gitSync(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'scripts', '.github/scripts', '.ai/scripts'], { cwd: repoRoot }).split('\0').filter(file => /\.[cm]?[jt]sx?$/.test(file));
  it.each([...new Set(files)])('%s keeps its listener', file => {
    expect(checkRule(probeReleasePort, file, readFileSync(join(repoRoot, file), 'utf8'))).toEqual([]);
  });
});
