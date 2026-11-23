import { describe, expect, it } from 'vitest';
import { probeReleasePorts } from './probe-release-port.ts';

describe('probe-then-release port guard', () => {
  it.each([
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
  ])('rejects an ephemeral port returned after closing its listener', source => {
    expect(probeReleasePorts(source)).toHaveLength(1);
  });

  it.each([
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
  ])('allows an owned port-0 listener and ignores comments', source => {
    expect(probeReleasePorts(source)).toEqual([]);
  });
});
