import { runnerDefinition } from './runner-registry.ts';
import { quoteExecutable } from './shell-env.ts';

/** The terminal executable of a runner as a shell word; null when the configured one cannot be
 *  spelled safely on this platform. */
export function terminalExecutable(runner: string, platform: NodeJS.Platform = process.platform): string | null {
  const executable = runnerDefinition(runner).cli.terminalExecutable;
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
export function resumeCommand(runner: string, sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) return null;
  const executable = terminalExecutable(runner);
  return executable === null ? null : `${executable} ${runnerDefinition(runner).cli.resumeArgs(sessionId)}`;
}
