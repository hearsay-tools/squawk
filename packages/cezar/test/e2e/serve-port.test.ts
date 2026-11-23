import '../../src/cli-boot.testkit.ts';
import { projectPaths } from '../../src/project-paths.ts';
import { prepareOperatorHome } from '../../src/home/entry.ts';
import { Home } from '../../src/home/home.ts';
import { STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { Agent, createServer, get, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { RunStore } from '../../src/runs/store.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Child cwd is a temporary repo: resolve the source loader here, never there.
// Built CLI coverage must run plain JS without a development-only loader.
const cliArgs = process.env.TEST_COCKPIT_SOURCE_CLI === '1'
  ? ['--import', import.meta.resolve('tsx'), join(packageRoot, 'src/index.ts')]
  : [join(packageRoot, 'dist/index.js')];

// Use node:http so ambient HTTP proxies cannot intercept loopback aliases.
async function localGet(url: string): Promise<{ status: number | undefined; text: string }> {
  const agent = new Agent();
  try {
    return await new Promise((resolve, reject) => {
      const request = get(url, { agent }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, text }));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.setTimeout(5_000, () => request.destroy(new Error(`Local request timed out: ${url}`)));
    });
  } finally { agent.destroy(); }
}

/** The run store as a clean shutdown leaves it: `runs.db` checkpointed, with no `-wal` or `-shm`.
 * A boot that opened it leaves its writes in the sidecars, or changes the bytes when it closes
 * cleanly (hearsay-tools/cezarion#779), so this is what "the index is unchanged" means now. */
async function storeSnapshot(dataDir: string): Promise<string> {
  const sidecars = ['-wal', '-shm'].filter((suffix) => existsSync(join(dataDir, `runs.db${suffix}`)));
  return `${createHash('sha256').update(await readFile(join(dataDir, 'runs.db'))).digest('hex')} ${sidecars.join(',')}`;
}

const EXACT_PORT_FLOOR = 10_000;

/** First port the OS assigns on its own: Linux reads it from procfs; other systems use the IANA range. */
function ephemeralRangeStart(): number {
  if (process.platform !== 'linux') return 49_152;
  const first = Number(readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/)[0]);
  assert.ok(first > EXACT_PORT_FLOOR, `ephemeral range starts at ${first}`);
  return first;
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cez-serve-port-')));
  const homeRoot = join(root, 'home');
  // Prepare migration once. These tests measure concurrent port admission.
  prepareOperatorHome(Home.sandbox(homeRoot), 'serve', { CEZ_HOME: homeRoot, HSQ_HOME: homeRoot });
  const children: ChildProcess[] = [];
  const occupants: Server[] = [];
  const repo = async (name: string) => {
    const directory = join(root, name);
    await mkdir(directory);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: directory });
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'fixture'], { cwd: directory });
    return directory;
  };
  const occupy = async (port = 0, host = '127.0.0.1') => {
    const server = createServer((_request, response) => response.end('ordinary server'));
    occupants.push(server);
    server.listen(port, host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return { server, port: address.port };
  };
  /** A free port for a cockpit to take by number. listen(0) and outgoing connections on every
   * process of the host draw from the ephemeral range, so a port probed there and released can
   * be taken before the cockpit binds it (hearsay-tools/squawk#3618). Pick one below that range. */
  const exactPort = async () => {
    const first = ephemeralRangeStart();
    for (let attempt = 0; attempt < 50; attempt++) {
      const port = EXACT_PORT_FLOOR + Math.floor(Math.random() * (first - EXACT_PORT_FLOOR));
      const server = createServer();
      try {
        server.listen(port, '127.0.0.1');
        await once(server, 'listening');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
        throw error;
      }
      await new Promise<void>((done) => server.close(() => done()));
      return port;
    }
    throw new Error(`No free port in ${EXACT_PORT_FLOOR}-${first - 1}`);
  };
  const start = (directory: string, args: string[] = []) => {
    const child = spawn(process.execPath, [...cliArgs, ...args, '--no-open'], {
      cwd: directory,
      env: { ...process.env, CEZ_HOME: join(root, 'home'), HSQ_HOME: join(root, 'home'), CEZ_DRY_RUN: '1', HSQ_DRY_RUN: '1', CEZ_AUTONAME: '0', HSQ_AUTONAME: '0', CEZ_REMOTE: '0', HSQ_REMOTE: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    return {
      child,
      async outcome() {
        for (let i = 0; i < 600; i++) {
          const url = output.match(/cockpit → (http:\/\/\S+)/)?.[1];
          if (url || child.exitCode !== null || child.signalCode !== null) return { url, code: child.exitCode, output };
          // e2e-wait: condition-poll — retry interval follows the child state probe
          await new Promise((done) => setTimeout(done, 50));
        }
        throw new Error(`CLI neither started nor exited: ${output}`);
      },
    };
  };
  const close = async () => {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
    await Promise.all(occupants.map((server) => new Promise<void>((done) => server.close(() => done()))));
    await rm(root, { recursive: true, force: true });
  };
  return { root, repo, occupy, exactPort, start, close };
}

function refused(result: { url?: string | undefined; code: number | null; output: string }, port: number) {
  assert.equal(result.code, 1, `occupied port must refuse, not bounce: ${result.output}`);
  assert.equal(result.url, undefined, result.output);
  assert.match(result.output, new RegExp(`port ${port}.*(in use|occupied)`, 'i'));
  assert.match(result.output, /existing cockpit/i);
  assert.match(result.output, /--port/);
  assert.match(result.output, /stop/i);
}

test('busy cockpit port from a different cwd refuses before recovery or startup resources', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const firstRepo = await f.repo('first');
    const secondRepo = await f.repo('second');
    const first = await f.start(firstRepo, ['--port', '0']).outcome();
    assert.ok(first.url, first.output);
    const port = Number(new URL(first.url).port);
    const dataDir = join(secondRepo, '.ai/cezar');
    const store = RunStore.open(dataDir);
    store.createRun({ title: 'must not recover', workflow: 'quick-task', task: 'must not run', worktree: false,
      steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
    // A clean shutdown: the run is durable in runs.db and its claim is released, so a boot that
    // went on to recover would be free to take it over (hearsay-tools/cezarion#779).
    store.close();
    const index = await storeSnapshot(dataDir);
    const orphan = join(dataDir, 'worktrees', 'orphan-sentinel');
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, 'sentinel'), 'preserve');
    const homeConfig = await readFile(Home.sandbox(join(f.root, 'home')).workspaceConfig, 'utf8');

    refused(await f.start(secondRepo, ['serve', '--port', String(port)]).outcome(), port);
    // The boot moves a legacy project to .ai/squawk/ before it takes the port (owner decision A):
    // read the store where the project keeps it now. A move carries the bytes; recovery would change them.
    const served = projectPaths(secondRepo).write;
    assert.equal(await storeSnapshot(served), index, 'rejected boot must not recover runs');
    assert.deepEqual(await readdir(join(served, 'runs')), [], 'no recovery event or agent resources');
    assert.equal(await readFile(join(served, 'worktrees', 'orphan-sentinel', 'sentinel'), 'utf8'), 'preserve', 'no startup pruning');
    assert.equal(await readFile(Home.sandbox(join(f.root, 'home')).workspaceConfig, 'utf8'), homeConfig, 'no registry mutation');
    assert.equal(existsSync(join(served, 'cockpit.lock')), false, 'rejection must release ownership');
    assert.equal((await localGet(`${first.url}/api/v1/health`)).status, 200, 'existing cockpit remains healthy');

    const deliberateRepo = await f.repo('deliberate');
    const free = await f.exactPort();
    const deliberate = await f.start(deliberateRepo, ['--port', String(free)]).outcome();
    assert.ok(deliberate.url, deliberate.output);
    assert.equal(Number(new URL(deliberate.url).port), free, 'explicit free port stays exact');
    assert.equal((await localGet(`${deliberate.url}/api/v1/health`)).status, 200);
  } finally { await f.close(); }
});

for (const host of ['127.0.0.1', '127.0.0.2']) test(`ordinary occupied port refuses on ${host}`, { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    const repo = await f.repo('repo');
    const expectedDataDir = projectPaths(repo).write;
    // A loopback-only probe on 127.0.0.1 would miss the 127.0.0.2 occupant.
    const { port } = await f.occupy(0, host);
    refused(await f.start(repo, ['--bind-host', host, '--port', String(port)]).outcome(), port);
    assert.equal(existsSync(join(expectedDataDir, 'runs')), false, 'no store initialized');
    assert.equal(existsSync(Home.sandbox(join(f.root, 'home')).workspaceConfig), false, 'no workspace initialized');
    assert.equal(existsSync(join(expectedDataDir, 'cockpit.lock')), false);
    assert.equal((await localGet(`http://${host}:${port}`)).text, 'ordinary server');
  } finally { await f.close(); }
});

test('default occupied port refuses; explicit zero still requests an ephemeral listener', { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    const repo = await f.repo('repo');
    // A host cockpit may already own the default port. Either way it is occupied;
    // never stop or modify a pre-existing listener.
    try { await f.occupy(4321); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'EADDRINUSE'); }
    refused(await f.start(repo).outcome(), 4321);
    const ephemeral = await f.start(repo, ['--port', '0']).outcome();
    assert.ok(ephemeral.url, ephemeral.output);
    assert.ok(Number(new URL(ephemeral.url).port) > 0);
    assert.equal((await localGet(`${ephemeral.url}/api/v1/health`)).status, 200);
  } finally { await f.close(); }
});

test('free default port starts on the requested bind host', { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    const repo = await f.repo('repo');
    // Keep the port default while isolating from the host cockpit's loopback address.
    const started = await f.start(repo, ['--bind-host', '::1']).outcome();
    assert.ok(started.url, started.output);
    assert.equal(started.url, 'http://[::1]:4321');
    assert.equal((await localGet(`${started.url}/api/v1/health`)).status, 200);
  } finally { await f.close(); }
});

test('different cwd contenders acquire the exact port once before either can recover', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const repos = await Promise.all([f.repo('first'), f.repo('second')]);
    const indexes = [];
    for (const repo of repos) {
      const store = RunStore.open(join(repo, '.ai/cezar'));
      store.createRun({ title: 'recovery sentinel', workflow: 'quick-task', task: 'sentinel', worktree: false,
        steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
      store.close(); // as above: durable, and free for a boot that wrongly recovered to take
      indexes.push(await storeSnapshot(join(repo, '.ai/cezar')));
    }
    const free = await f.exactPort();
    const contenders = repos.map((repo) => f.start(repo, ['--port', String(free)]));
    const outcomes = await Promise.all(contenders.map((child) => child.outcome()));
    assert.equal(outcomes.filter((outcome) => outcome.url).length, 1, JSON.stringify(outcomes));
    const loser = outcomes.findIndex((outcome) => outcome.code === 1);
    assert.ok(loser >= 0, JSON.stringify(outcomes));
    refused(outcomes[loser]!, free);
    // As above: the loser's boot may have moved its project before the race for the port.
    const served = projectPaths(repos[loser]!).write;
    assert.equal(await storeSnapshot(served), indexes[loser]);
    assert.deepEqual(await readdir(join(served, 'runs')), []);
    assert.equal(existsSync(join(served, 'cockpit.lock')), false);
    const winner = outcomes.find((outcome) => outcome.url)!;
    assert.equal(Number(new URL(winner.url!).port), free);
    assert.equal((await localGet(`${winner.url}/api/v1/health`)).status, 200);
  } finally { await f.close(); }
});
