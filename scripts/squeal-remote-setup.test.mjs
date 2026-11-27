import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  assertPinnedAgentBrowserMatch,
  packBuildContext,
  publishTemplate,
  readDockerfileAgentBrowserVersion,
} from '../.ai/scripts/build-squawk-runner.mjs';
import { readTestEnvInputs } from '../.ai/scripts/test-env-inputs.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_PIN = '9.9.9';

function commandPath(name) {
  return execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
}

function makeSetupFixture(t, {
  pin = FIXTURE_PIN,
  onPathBrowserVersion = FIXTURE_PIN,
  hasChrome = true,
  probeBareSuccess = true,
  probeNoSandboxSuccess = true,
  downloadReportsVersion = FIXTURE_PIN,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cez-remote-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.ai/scripts'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true });
  mkdirSync(join(root, 'cache'), { recursive: true });

  copyFileSync(join(repoRoot, '.ai/scripts/squeal-remote-setup.sh'), join(root, '.ai/scripts/squeal-remote-setup.sh'));
  copyFileSync(join(repoRoot, '.ai/scripts/test-env-inputs.mjs'), join(root, '.ai/scripts/test-env-inputs.mjs'));
  copyFileSync(join(repoRoot, '.ai/scripts/resolve-browser-launch.mjs'), join(root, '.ai/scripts/resolve-browser-launch.mjs'));
  writeFileSync(join(root, '.ai/scripts/test-env.inputs.json'), JSON.stringify({
    version: 1,
    server: { env: [] },
    browser: { agentBrowserVersion: pin },
  }, null, 2) + '\n');

  for (const cmd of ['cat', 'chmod', 'dirname', 'grep', 'id', 'mkdir', 'mv', 'pwd', 'rm', 'sh', 'uname']) {
    symlinkSync(commandPath(cmd), join(root, 'bin', cmd));
  }
  symlinkSync(process.execPath, join(root, 'bin/node'));

  const browserScript = (reportedVersion) => `#!/bin/sh
printf '%s\\n' "$*" >> "${join(root, 'browser.argv')}"
args_val=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --args) args_val=$2; shift 2 ;;
    --session) shift 2 ;;
    --json) shift ;;
    --version) printf 'agent-browser ${reportedVersion}\\n'; exit 0 ;;
    open)
      case ",$args_val," in
        *,--no-sandbox,*)
          [ "${probeNoSandboxSuccess ? 1 : 0}" = 1 ] && printf '{"success":true}\\n' || printf '{"success":false}\\n'
          exit 0 ;;
        *)
          [ "${probeBareSuccess ? 1 : 0}" = 1 ] && printf '{"success":true}\\n' || printf '{"success":false}\\n'
          exit 0 ;;
      esac ;;
    close) printf '{"success":true}\\n'; exit 0 ;;
    *) shift ;;
  esac
done
`;

  if (onPathBrowserVersion !== null) {
    writeFileSync(join(root, 'bin/agent-browser'), browserScript(onPathBrowserVersion), { mode: 0o755 });
  }
  if (hasChrome) {
    writeFileSync(join(root, 'bin/google-chrome'), '#!/bin/sh\necho "Google Chrome 154.0.0.0"\n', { mode: 0o755 });
  }
  writeFileSync(join(root, 'bin/curl.download'), browserScript(downloadReportsVersion));
  writeFileSync(join(root, 'bin/curl'), `#!/bin/sh
out=
prev=
for arg do
  [ "$prev" != -o ] || out=$arg
  prev=$arg
  url=$arg
done
printf '%s\\n' "$url" >> "${join(root, 'curl.urls')}"
cat "$0.download" > "$out"
exit 0
`, { mode: 0o755 });

  return {
    root,
    env: {
      PATH: join(root, 'bin'),
      HOME: join(root, 'home'),
      XDG_CACHE_HOME: join(root, 'cache'),
      TMPDIR: '/tmp',
    },
  };
}

test('squeal.config.json wires remote.setup and per-file requires.commands for browser specs', () => {
  const config = JSON.parse(readFileSync(join(repoRoot, 'squeal.config.json'), 'utf8'));
  assert.equal(config.remote?.setup, '.ai/scripts/squeal-remote-setup.sh');
  assert.deepEqual(config.requires?.commands?.['packages/web/e2e/*.e2e.ts'], ['google-chrome']);
  const setupStat = statSync(join(repoRoot, config.remote.setup));
  assert.notEqual(setupStat.mode & 0o111, 0, 'remote.setup script must be executable');
});

test('squawk-runner Dockerfile matches pinned agentBrowserVersion and bakes Chrome outside /home/node', () => {
  const { inputs } = readTestEnvInputs(repoRoot);
  assert.equal(assertPinnedAgentBrowserMatch(repoRoot), inputs.browser.agentBrowserVersion);
  const dockerfile = readFileSync(join(repoRoot, '.ai/squeal-runner/Dockerfile'), 'utf8');
  assert.equal(readDockerfileAgentBrowserVersion(dockerfile), inputs.browser.agentBrowserVersion);
  assert.match(dockerfile, /^FROM ubuntu:26\.04$/m);
  assert.match(dockerfile, /google-chrome-stable/);
  assert.match(dockerfile, /\/usr\/local\/bin\/agent-browser/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/tini", "--"\]/);
});

test('assertPinnedAgentBrowserMatch rejects drift between Dockerfile and test-env.inputs.json', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-pin-drift-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.ai/scripts'), { recursive: true });
  mkdirSync(join(dir, '.ai/squeal-runner'), { recursive: true });
  writeFileSync(join(dir, '.ai/scripts/test-env.inputs.json'), JSON.stringify({
    version: 1, server: { env: [] }, browser: { agentBrowserVersion: '0.40.0' },
  }));
  writeFileSync(join(dir, '.ai/squeal-runner/Dockerfile'), 'FROM ubuntu:26.04\nARG AGENT_BROWSER_VERSION=0.39.4\n');
  assert.throws(() => assertPinnedAgentBrowserMatch(dir), /pins AGENT_BROWSER_VERSION=0\.39\.4.*pins 0\.40\.0/);
});

test('squeal-remote-setup succeeds cleanly on a prebaked squawk-runner host', (t) => {
  const fx = makeSetupFixture(t);
  const run = spawnSync('/bin/sh', [join(fx.root, '.ai/scripts/squeal-remote-setup.sh')], {
    encoding: 'utf8', env: fx.env, timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /ready: Google Chrome 154\.0\.0\.0 \+ agent-browser 9\.9\.9/);
});

test('squeal-remote-setup retries headless probe with --no-sandbox when bare launch fails', (t) => {
  const fx = makeSetupFixture(t, { probeBareSuccess: false, probeNoSandboxSuccess: true });
  const run = spawnSync('/bin/sh', [join(fx.root, '.ai/scripts/squeal-remote-setup.sh')], {
    encoding: 'utf8', env: fx.env, timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(readFileSync(join(fx.root, 'browser.argv'), 'utf8'), /--args --no-sandbox/);
});

test('squeal-remote-setup exits 0 with hint when google-chrome is absent and no root/sudo is available', (t) => {
  const fx = makeSetupFixture(t, { hasChrome: false });
  const run = spawnSync('/bin/sh', [join(fx.root, '.ai/scripts/squeal-remote-setup.sh')], {
    encoding: 'utf8', env: fx.env, timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /google-chrome is not installed.*squawk-runner/);
});

test('squeal-remote-setup fails non-zero when google-chrome is present but headless launch fails', (t) => {
  const fx = makeSetupFixture(t, { hasChrome: true, probeBareSuccess: false, probeNoSandboxSuccess: false });
  const run = spawnSync('/bin/sh', [join(fx.root, '.ai/scripts/squeal-remote-setup.sh')], {
    encoding: 'utf8', env: fx.env, timeout: 10_000,
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /headless launch failed/);
});

test('squeal-remote-setup downloads pinned agent-browser when PATH holds another version', (t) => {
  const fx = makeSetupFixture(t, { onPathBrowserVersion: '0.1.0', downloadReportsVersion: FIXTURE_PIN });
  const run = spawnSync('/bin/sh', [join(fx.root, '.ai/scripts/squeal-remote-setup.sh')], {
    encoding: 'utf8', env: fx.env, timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(readFileSync(join(fx.root, 'curl.urls'), 'utf8'), /releases\/download\/v9\.9\.9\/agent-browser-/);
  assert.match(run.stderr, /ready: .*agent-browser 9\.9\.9/);
});

async function startBuildStubServer(t, { failBuild = false } = {}) {
  const seen = { createBody: null, uploadAuth: null, uploadBytes: 0, startCalled: false, logOffsets: [] };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/v1/template-builds') {
        seen.createBody = JSON.parse(body.toString('utf8'));
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'tb_0123456789abcdef0123',
          name: seen.createBody.name,
          status: 'created',
          upload_url: `http://127.0.0.1:${server.address().port}/upload/signed`,
        }));
        return;
      }
      if (req.method === 'PUT' && url.pathname === '/upload/signed') {
        seen.uploadAuth = req.headers.authorization ?? null;
        seen.uploadBytes = body.length;
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/template-builds/tb_0123456789abcdef0123/start') {
        seen.startCalled = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'tb_0123456789abcdef0123', status: 'building' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/template-builds/tb_0123456789abcdef0123/logs') {
        const offset = Number(url.searchParams.get('offset') ?? '0');
        seen.logOffsets.push(offset);
        res.writeHead(200, { 'content-type': 'application/json' });
        if (offset === 0) {
          res.end(JSON.stringify({ id: 'tb_0123456789abcdef0123', status: 'building', offset: 12, data: 'step 1 done\n' }));
        } else if (failBuild) {
          res.end(JSON.stringify({
            id: 'tb_0123456789abcdef0123',
            status: 'failed',
            offset: 24,
            data: 'step 2 fail\n',
            error: { code: 'build_failed', message: 'apt-get exited 100' },
          }));
        } else {
          res.end(JSON.stringify({
            id: 'tb_0123456789abcdef0123',
            status: 'succeeded',
            offset: 25,
            data: 'exporting ok\n',
            template: { name: 'squawk-runner', revision: 1, image_digest: 'sha256:deadbeef' },
          }));
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, seen };
}

test('publishTemplate packs Dockerfile at archive root, uploads without auth header, and streams logs', async (t) => {
  const { baseUrl, seen } = await startBuildStubServer(t);
  const logs = [];
  const published = await publishTemplate({
    repoRoot,
    apiBaseUrl: baseUrl,
    authToken: 'test-token',
    pollIntervalMs: 1,
    onLog: (chunk) => logs.push(chunk),
  });
  assert.equal(seen.createBody.name, 'squawk-runner');
  assert.equal(seen.uploadBytes, seen.createBody.size_bytes);
  assert.equal(seen.uploadAuth, null, 'presigned upload URL must never receive Authorization header');
  assert.equal(seen.startCalled, true);
  assert.deepEqual(seen.logOffsets, [0, 12]);
  assert.equal(logs.join(''), 'step 1 done\nexporting ok\n');
  assert.deepEqual(published.template, { name: 'squawk-runner', revision: 1, image_digest: 'sha256:deadbeef' });

  const workDir = mkdtempSync(join(tmpdir(), 'cez-pack-check-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const archive = join(workDir, 'ctx.tar.gz');
  packBuildContext(join(repoRoot, '.ai/squeal-runner'), archive);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.match(entries, /^\.\/Dockerfile$/m);
});

test('publishTemplate surfaces build_failed reason from Agent37 API', async (t) => {
  const { baseUrl } = await startBuildStubServer(t, { failBuild: true });
  await assert.rejects(
    () => publishTemplate({
      repoRoot,
      apiBaseUrl: baseUrl,
      authToken: 'test-token',
      pollIntervalMs: 1,
      onLog: () => {},
    }),
    /build_failed.*apt-get exited 100/,
  );
});
