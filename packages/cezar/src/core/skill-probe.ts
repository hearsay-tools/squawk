import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildChildEnv } from './agent-env.ts';
import { profileEnv } from './agent-profiles.ts';
import { productEnv } from './product-env.ts';
import { runnerDefinition } from './runner-registry.ts';
import { processGroupAlive, sessionGroupOf, signalOwnedSessionGroup, signalSession, spawnSessionLeader } from './session-process.ts';

export interface SkillDiscoveryOptions {
  cwd: string;
  accountHome?: string | undefined;
  bin?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  spawn?: ((bin: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams) | undefined;
}

export interface SkillProbeExtra {
  executable?: string | undefined;
  extraEnv?: Record<string, string> | undefined;
  onSpawn?: ((pid: number) => void) | undefined;
}

export function skillExecutable(runner: string, bin?: string): string {
  return bin ?? { claude: productEnv('CLAUDE_BIN'), codex: productEnv('CODEX_BIN'),
    opencode: productEnv('OPENCODE_BIN'), pi: productEnv('PI_BIN'), omp: productEnv('OMP_BIN'),
    antigravity: productEnv('ANTIGRAVITY_BIN') }[runner] ?? (productEnv('DRY_RUN') === '1'
    ? fileURLToPath(new URL(`../../scripts/${runnerDefinition(runner).mock.script}`, import.meta.url)) : runner);
}

/** A no-turn probe owns a process group. Kill it and observe exit before releasing its caller. */
export async function skillProbe<T>(
  runner: string,
  args: readonly string[],
  options: SkillDiscoveryOptions,
  read: (child: ChildProcessWithoutNullStreams, signal: AbortSignal, env: NodeJS.ProcessEnv) => Promise<T>,
  extra: SkillProbeExtra = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  const env = buildChildEnv({ backend: runner, extraEnv: { ...profileEnv(runner, options.accountHome), ...extra.extraEnv } });
  const launch = options.spawn ?? ((bin, argv, cwd, env) => spawnSessionLeader(bin, argv, { cwd, env }));
  const child = launch(extra.executable ?? skillExecutable(runner, options.bin), args, options.cwd, env);
  const group = child.pid === undefined ? undefined : sessionGroupOf(child.pid);
  const exited = probeExit(child);
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)]);
  const kill = () => group === undefined ? signalSession(child, 'SIGKILL') : signalOwnedSessionGroup(child, 'SIGKILL');
  child.stderr.on('error', () => {});
  child.stderr.resume();
  child.stdin.on('error', () => {});
  let onAbort: () => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    child.once('error', () => reject(new Error('Skill probe child failed')));
    child.once('exit', code => { if (code !== 0) reject(new Error('Skill probe exited before answering')); });
  });
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { kill(); reject(new Error('Skill probe timed out or was cancelled')); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  // If onSpawn throws before Promise.race attaches handlers, killing the child in finally rejects failed.
  failed.catch(() => {});
  aborted.catch(() => {});
  try {
    if (child.pid !== undefined) extra.onSpawn?.(child.pid);
    return await Promise.race([read(child, signal, env), failed, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
    kill();
    await exited;
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    if (group !== undefined) await waitForProbeGroup(group);
  }
}

/** Group disappearance is the cleanup signal; poll it within the catalog's one-second grace. */
async function waitForProbeGroup(group: number): Promise<void> {
  const deadline = performance.now() + 750;
  while (processGroupAlive(group)) {
    if (performance.now() >= deadline) throw new Error('Skill probe process group did not exit');
    await delay(10);
  }
}

/** Bound streams even when a CLI emits a single line without a newline. */
export async function* skillLines(child: ChildProcessWithoutNullStreams): AsyncGenerator<string> {
  child.stdout.setEncoding('utf8');
  let pending = '';
  let size = 0;
  for await (const chunk of child.stdout) {
    size += Buffer.byteLength(chunk);
    if (size > 4 * 1024 * 1024) throw new Error('Skill probe exceeded the output limit');
    pending += chunk.toString();
    let end: number;
    while ((end = pending.indexOf('\n')) !== -1) {
      yield pending.slice(0, end);
      pending = pending.slice(end + 1);
    }
  }
  if (pending) yield pending;
}

/** CLI list commands finish on EOF; errors and deadlines are owned by skillProbe. */
export async function skillOutput(child: ChildProcessWithoutNullStreams): Promise<string> {
  const exited = probeExit(child);
  const lines: string[] = [];
  for await (const line of skillLines(child)) lines.push(line);
  if (await exited !== 0) throw new Error('Skill list command failed');
  return lines.join('\n');
}

function probeExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise(resolve => {
    child.once('exit', resolve);
    child.once('error', () => { if (child.pid === undefined) resolve(null); });
  });
}
