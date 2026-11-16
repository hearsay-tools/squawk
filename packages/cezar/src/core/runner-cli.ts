import type { RunnerId } from './agent-runner.ts';
import { resolveCursorExecutable } from './cursor-model-catalog.ts';
import { resolveOmpExecutable } from './omp-model-catalog.ts';
import { quoteExecutable } from './shell-env.ts';

/**
 * How a terminal starts each runner's own CLI, the take-over command of "Open in terminal" and
 * the cockpit's copyable resume line (hearsay-tools/squawk#3642).
 */
export interface RunnerCli {
  /**
   * The executable a terminal runs. `path-name`: the CLI's name on PATH. `configured`: the
   * executable the server resolves from its `HSQ_*_BIN` override, so only the server can spell it.
   */
  readonly terminalExecutable: { readonly kind: 'path-name'; readonly name: string } | { readonly kind: 'configured'; readonly resolve: () => string };
  /** The arguments that reopen a recorded session, after the executable. */
  readonly resumeArgs: (sessionId: string) => string;
}

export const RUNNER_CLI: Readonly<Record<RunnerId, RunnerCli>> = {
  claude: { terminalExecutable: { kind: 'path-name', name: 'claude' }, resumeArgs: id => `--resume ${id}` },
  codex: { terminalExecutable: { kind: 'path-name', name: 'codex' }, resumeArgs: id => `resume ${id}` },
  opencode: { terminalExecutable: { kind: 'path-name', name: 'opencode' }, resumeArgs: id => `--session ${id}` },
  pi: { terminalExecutable: { kind: 'path-name', name: 'pi' }, resumeArgs: id => `--session ${id}` },
  cursor: { terminalExecutable: { kind: 'configured', resolve: () => resolveCursorExecutable() }, resumeArgs: id => `--resume ${id}` },
  omp: { terminalExecutable: { kind: 'configured', resolve: () => resolveOmpExecutable() }, resumeArgs: id => `--resume ${id}` },
};

/** The terminal executable of a runner as a shell word; null when the configured one cannot be
 *  spelled safely on this platform. */
export function terminalExecutable(runner: RunnerId, platform: NodeJS.Platform = process.platform): string | null {
  const executable = RUNNER_CLI[runner].terminalExecutable;
  return executable.kind === 'path-name' ? executable.name : quoteExecutable(executable.resolve(), platform);
}

/**
 * The session id shape every backend actually mints: UUIDs (claude/codex) and
 * the CLIs' own slug-ish ids. No character here is special to bash, AppleScript
 * OR cmd.exe, and a leading `-` is refused so the id can never be read as an
 * option by the CLI it is passed to (same dash-guard as `isSafeGitRef`, open-mercato/cezar#431).
 * Bounded, like every other input that reaches a spawned process.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,199}$/;

/** True for session ids safe to splice into the take-over command (see above). */
export function isSafeSessionId(sessionId: string): boolean {
  return SAFE_SESSION_ID.test(sessionId);
}

/**
 * The native session take-over command. Refuse unrecognized session-id shapes, and configured
 * executables the platform cannot quote, rather than embed unsafe or platform-misquoted values.
 */
export function resumeCommand(runner: RunnerId, sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) return null;
  const executable = terminalExecutable(runner);
  return executable === null ? null : `${executable} ${RUNNER_CLI[runner].resumeArgs(sessionId)}`;
}
