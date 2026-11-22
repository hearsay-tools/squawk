import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autosaveCommit } from './autosave-commit.ts';
import { shellQuote } from './core/shell-env.ts';

const realGit = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).trim().split('\n')[0]!;
const branch = 'cez/probes';

describe('autosave batched probes', () => {
  let repo: string;
  let bin: string;
  const git = (...args: string[]) => execFileSync(realGit, args, { cwd: repo, encoding: 'utf8' }).trim();
  const save = () => autosaveCommit(repo, 'turn end', { taskBranch: branch, onOutcome: () => {} });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'autosave-probes-'));
    bin = mkdtempSync(join(tmpdir(), 'autosave-probes-bin-'));
    const globalConfig = join(bin, 'global-config');
    writeFileSync(globalConfig, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) vi.stubEnv(key, undefined);
    git('init', '-q', '-b', branch);
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@local');
    writeFileSync(join(repo, 'work.txt'), 'base\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    writeFileSync(join(repo, 'work.txt'), 'edited\n');
  });
  afterEach(() => {
    vi.unstubAllEnvs(); vi.restoreAllMocks();
    rmSync(repo, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });
  function shim(body: string[]) {
    writeFileSync(join(bin, 'git'), ['#!/bin/sh', ...body, `exec ${shellQuote(realGit)} "$@"`, ''].join('\n'), { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  }

  it.runIf(process.platform !== 'win32')('uses 16 Git calls with reporting, and batches identity and tip/tree', async () => {
    const log = join(bin, 'calls');
    shim([`printf '%s\\n' "$*" >> ${shellQuote(log)}`]);
    expect(await save()).toBe('committed');
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(16);
    expect(calls.filter(call => call.includes('config '))).toHaveLength(1);
    expect(calls.filter(call => call.includes('for-each-ref '))).toHaveLength(1);
    expect(calls.filter(call => call.includes('rev-parse --verify -q MERGE_HEAD'))).toHaveLength(2);
    expect(calls.at(-2)).toContain('update-ref -m cezar autosave (turn end)');
  });

  it('uses the last configured identity and keeps newlines inside values', async () => {
    git('config', '--add', 'user.name', 'last\nname');
    git('config', '--add', 'user.email', 'last@local');
    expect(await save()).toBe('committed');
    expect(git('log', '-1', '--format=%an <%ae>')).toBe('lastname <last@local>');
  });

  it('uses the fallback identity when the batched config has no keys (exit 1)', async () => {
    git('config', '--unset-all', 'user.name');
    git('config', '--unset-all', 'user.email');
    expect(await save()).toBe('committed');
    expect(git('log', '-1', '--format=%an <%ae>')).toBe('cezar <cezar@local>');
  });

  it.runIf(process.platform !== 'win32')('does not publish after a failed batched config read', async () => {
    const before = git('rev-parse', 'HEAD');
    shim(['case " $* " in *" config --null --get-regexp "*) exit 128;; esac']);
    expect(await save()).toBe('failed');
    expect(git('rev-parse', 'HEAD')).toBe(before);
  });

  it.runIf(process.platform !== 'win32')('does not publish after a failed batched tip/tree read', async () => {
    const before = git('rev-parse', 'HEAD');
    shim(['case " $* " in *" for-each-ref "*) exit 128;; esac']);
    expect(await save()).toBe('failed');
    expect(git('rev-parse', 'HEAD')).toBe(before);
  });

  // Keep Git's boolean parser: named values, valueless keys, numeric bases/units and errors.
  it.runIf(process.platform !== 'win32').each(['true', 'YES', 'off', '', '-1', '0x1', '010', '0k', '1m', '2147483648', 'invalid', null])('preserves signing normalization for %s', async value => {
    if (value === null) appendFileSync(join(repo, '.git', 'config'), '\n[commit]\n\tgpgsign\n');
    else git('config', 'commit.gpgsign', value);
    let normalized: string;
    try { normalized = git('config', '--type=bool', 'commit.gpgsign'); }
    catch { normalized = 'failed'; }
    const log = join(bin, 'commit-args');
    const gpg = join(bin, 'gpg');
    writeFileSync(gpg, ['#!/bin/sh', 'cat >/dev/null',
      "printf '\\n[GNUPG:] SIG_CREATED D 1 8 00 0 0\\n' >&2",
      "printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nfake\\n-----END PGP SIGNATURE-----\\n'", ''].join('\n'), { mode: 0o755 });
    git('config', 'gpg.program', gpg);
    shim([`case " $* " in *" commit-tree "*) printf '%s\\n' "$*" > ${shellQuote(log)};; esac`]);
    if (normalized === 'failed') {
      expect(await save()).toBe('failed');
    } else {
      expect(await save()).toBe('committed');
      expect(readFileSync(log, 'utf8').includes('commit-tree -S ')).toBe(normalized === 'true');
    }
  });

  it.each(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'])('refuses a dangling %s before staging', async pending => {
    // rev-parse resolves this recorded ref even when its object is missing. log --ignore-missing hides it.
    writeFileSync(join(repo, '.git', pending), `${'f'.repeat(40)}\n`);
    const before = git('status', '--porcelain');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await save()).toBe('refused');
    expect(git('status', '--porcelain')).toBe(before);
  });

  it('saves and checks pending root refs with the reftable backend', async ({ skip }) => {
    const table = join(bin, 'reftable');
    try { git('init', '-q', '--ref-format=reftable', '-b', branch, table); }
    catch { skip(); return; } // Git before 2.45 cannot create a reftable fixture.
    const tableGit = (...args: string[]) => execFileSync(realGit, args, { cwd: table, encoding: 'utf8' }).trim();
    writeFileSync(join(table, 'work.txt'), 'first\n');
    expect(await autosaveCommit(table, 'turn end', { taskBranch: branch })).toBe('committed');
    const tip = tableGit('rev-parse', 'HEAD');
    writeFileSync(join(table, 'work.txt'), 'edited\n');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      // MERGE_HEAD is always a file; only the other two live in the ref backend.
      if (ref === 'MERGE_HEAD') writeFileSync(join(table, '.git', ref), `${tip}\n`);
      else tableGit('update-ref', ref, tip);
      expect(await autosaveCommit(table, 'turn end', { taskBranch: branch })).toBe('refused');
      expect(tableGit('status', '--porcelain')).toBe('M work.txt');
      if (ref === 'MERGE_HEAD') rmSync(join(table, '.git', ref));
      else tableGit('update-ref', '-d', ref);
    }
    expect(await autosaveCommit(table, 'turn end', { taskBranch: branch })).toBe('committed');
  });
});
