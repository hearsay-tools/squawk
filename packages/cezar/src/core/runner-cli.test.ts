import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import '../core/register-all-runners.testkit.ts';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSafeSessionId, resumeCommand, terminalExecutable } from './runner-cli.ts';
import { runnerDefinition } from './runner-registry.ts';
import { sessionId, unsafeSessionIds } from '../../test/fixtures/resume-commands.ts';

// The golden take-over command of every runner is a file in its own folder.
const goldenCommand = (runner: string): string => readFileSync(new URL(`../runners/${runner}/__fixtures__/resume-command.txt`, import.meta.url), 'utf8').trimEnd();

describe('resume commands — shared golden parity across BUILT_IN_RUNNER_IDS', () => {
  beforeEach(() => { vi.stubEnv('CEZ_OMP_BIN', undefined); });
  afterEach(() => vi.unstubAllEnvs());

  it.each(BUILT_IN_RUNNER_IDS)('matches the golden take-over command for %s', (runner) => {
    expect(resumeCommand(runner, sessionId)).toBe(goldenCommand(runner));
  });

  it.each(BUILT_IN_RUNNER_IDS)('rejects unsafe session ids for %s', (runner) => {
    for (const id of unsafeSessionIds) {
      expect(resumeCommand(runner, id)).toBeNull();
    }
  });
});

/**
 * Terminal take-over (open-mercato/cezar#431): `resumeCommand`'s session id is the only variable
 * spliced into the command string that openInTerminal hands to bash (darwin),
 * a temp bash script (linux) or `cmd /K` (win32). Because cmd.exe has no
 * concept of `'`-quoting, the id is VALIDATED rather than quoted: recognised
 * ids go through verbatim (correct in every shell), anything else fails closed.
 */
describe('resumeCommand — session id validation', () => {
  it('never emits a quote character — a POSIX quote would reach cmd.exe literally on win32', () => {
    const cmd = resumeCommand('claude', 'ses_01ABC.def-42');
    expect(cmd).toBe('claude --resume ses_01ABC.def-42');
    expect(cmd).not.toContain("'");
    expect(cmd).not.toContain('"');
  });

  it('refuses a hostile-shaped id rather than escaping it', () => {
    expect(resumeCommand('claude', '$(touch /tmp/pwn); rm -rf ~ #')).toBeNull();
    expect(resumeCommand('claude', "a'b")).toBeNull();
    expect(resumeCommand('codex', 'a && calc.exe')).toBeNull();
    expect(resumeCommand('opencode', 'a`id`')).toBeNull();
    expect(resumeCommand('claude', 'a b')).toBeNull();
    expect(resumeCommand('claude', '')).toBeNull();
  });

  it('bounds the id length', () => {
    expect(isSafeSessionId('a'.repeat(200))).toBe(true);
    expect(isSafeSessionId('a'.repeat(201))).toBe(false);
  });

  it('accepts the shapes the backends actually mint', () => {
    for (const id of [
      '9f8e7d6c-1234-4abc-9def-0123456789ab',
      'ses_01JABCDEF',
      'session.2026-07-17',
    ]) {
      expect(isSafeSessionId(id)).toBe(true);
    }
  });
});

describe('terminalExecutable — PATH name or the configured executable', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('starts a path-name runner by its PATH name, even in dry-run', () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    for (const runner of BUILT_IN_RUNNER_IDS) {
      const executable = runnerDefinition(runner).cli.terminalExecutable;
      if (executable.kind === 'path-name') expect(terminalExecutable(runner)).toBe(executable.name);
    }
  });

  it.each(BUILT_IN_RUNNER_IDS.filter(runner => runnerDefinition(runner).cli.terminalExecutable.kind === 'configured'))(
    'quotes the configured %s executable, and refuses one the platform cannot spell', (runner) => {
      const variable = `HSQ_${runner.toUpperCase()}_BIN`;
      vi.stubEnv(variable, '/opt/Some Agent/bin');
      expect(terminalExecutable(runner, 'linux')).toBe("'/opt/Some Agent/bin'");
      vi.stubEnv(variable, '/opt/a"b/bin');
      expect(terminalExecutable(runner, 'win32')).toBeNull();
    });
});
