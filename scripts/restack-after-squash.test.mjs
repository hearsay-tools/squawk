import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { shellWord } from './restack-after-squash.mjs';

const SCRIPT = fileURLToPath(new URL('./restack-after-squash.mjs', import.meta.url));

function write(dir, file, lines) {
  fs.writeFileSync(path.join(dir, file), `${lines.join('\n')}\n`);
}

/**
 * A bare `origin`, a clone `w` and a fake `gh` that prints `pr.json`. `parent` is pull request 1 with one
 * commit on `a`; `child` is stacked on it (`b`, then `a`). With `late`, pull request 1 gains a commit after
 * `child` forked. Main moves `c`, then pull request 1 is squash-merged into main, as GitHub does.
 */
function stackedRepo(t, { late = false, state = 'MERGED' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const w = path.join(root, 'w');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, w], { stdio: 'ignore' });
  const git = (...args) => execFileSync('git', args, { cwd: w, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('switch', '-q', '-c', 'main');
  for (const f of ['a', 'b', 'c']) write(w, f, ['1', '2', '3', '4', '5']);
  git('add', '.');
  git('commit', '-qm', 'init');
  git('push', '-q', 'origin', 'main');
  git('switch', '-qc', 'parent');
  write(w, 'a', ['1', 'P1', '3', '4', '5']);
  git('commit', '-qam', 'p1');
  git('switch', '-qc', 'child');
  write(w, 'b', ['1', 'C', '3', '4', '5']);
  git('commit', '-qam', 'c1');
  write(w, 'a', ['C0', 'P1', '3', '4', '5']);
  git('commit', '-qam', 'c2');
  git('switch', '-q', 'parent');
  if (late) {
    write(w, 'a', ['1', 'P1', '3', 'P3', '5']);
    git('commit', '-qam', 'p3');
  }
  const finalHead = git('rev-parse', 'parent');
  git('push', '-q', 'origin', 'parent:refs/pull/1/head');
  git('switch', '-q', 'main');
  write(w, 'c', ['1', '2', '3', '4', 'M']);
  git('commit', '-qam', 'main moves');
  git('merge', '-q', '--squash', 'parent');
  git('commit', '-qm', 'parent (#1)');
  git('push', '-q', 'origin', 'main');
  git('branch', '-q', '-D', 'parent');
  git('switch', '-q', 'child');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const ghJson = path.join(root, 'pr.json');
  fs.writeFileSync(ghJson, JSON.stringify({ state, headRefOid: finalHead, baseRefName: 'main' }));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ncat ${shellWord(ghJson)}\n`, { mode: 0o755 });
  const restack = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: w,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  return { w, git, finalHead, restack, read: f => fs.readFileSync(path.join(w, f), 'utf8') };
}

test('a plain merge of origin/main conflicts on the stacked branch; the restack replays only its own commits', t => {
  const repo = stackedRepo(t);
  repo.git('fetch', '-q', 'origin');
  assert.equal(spawnSync('git', ['merge', '--no-edit', 'origin/main'], { cwd: repo.w }).status, 1);
  repo.git('merge', '--abort');
  const result = repo.restack('1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(repo.git('log', '--format=%s', 'origin/main..HEAD'), 'c2\nc1');
  assert.equal(repo.read('a'), 'C0\nP1\n3\n4\n5\n');
  assert.equal(repo.read('c'), '1\n2\n3\n4\nM\n');
  assert.match(result.stdout, /Own patch unchanged/);
  assert.match(result.stdout, /Push: git push --force-with-lease=child:[0-9a-f]{40} origin HEAD:child/);
});

test('a branch forked before the base PR gained a commit keeps that commit after the rebase', t => {
  const repo = stackedRepo(t, { late: true });
  const result = repo.restack('1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(repo.git('log', '--format=%s', 'origin/main..HEAD'), 'c2\nc1');
  assert.equal(repo.read('a'), 'C0\nP1\n3\nP3\n5\n');
  assert.match(result.stdout, /Own patch unchanged/);
});

test('--merge keeps the old head, keeps the base PR\'s later commit and gives the rebase\'s tree', t => {
  const repo = stackedRepo(t, { late: true });
  const oldHead = repo.git('rev-parse', 'HEAD');
  const result = repo.restack('1', '--merge');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(repo.git('merge-base', '--is-ancestor', oldHead, 'HEAD'), '');
  assert.equal(repo.git('merge-base', '--is-ancestor', 'origin/main', 'HEAD'), '');
  assert.equal(repo.read('a'), 'C0\nP1\n3\nP3\n5\n');
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.match(result.stdout, /Own patch unchanged/);
  assert.match(result.stdout, /Push: git push origin HEAD:child/);
});

test('--merge changes nothing when main changed the same line after the squash', t => {
  const repo = stackedRepo(t);
  repo.git('switch', '-q', 'main');
  write(repo.w, 'a', ['M0', 'P1', '3', '4', '5']);
  repo.git('commit', '-qam', 'main edits line 1');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('switch', '-q', 'child');
  const before = repo.git('rev-parse', 'HEAD');
  const result = repo.restack('1', '--merge');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /conflicts in: a\. Nothing was changed/);
  assert.equal(repo.git('rev-parse', 'HEAD'), before);
  assert.equal(repo.git('status', '--porcelain'), '');
});

test('a rebase conflict stops in Git\'s rebase state and names the file and the abort', t => {
  const repo = stackedRepo(t);
  repo.git('switch', '-q', 'main');
  write(repo.w, 'b', ['1', 'M', '3', '4', '5']);
  repo.git('commit', '-qam', 'main edits b');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('switch', '-q', 'child');
  const result = repo.restack('1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /conflict in: b\. .*git rebase --abort/);
  repo.git('rebase', '--abort');
});

test('--dry-run lists the own commits and changes nothing', t => {
  const repo = stackedRepo(t);
  const before = repo.git('rev-parse', 'HEAD');
  const result = repo.restack('1', '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /c2\n.*c1\nDry run: nothing changed/);
  assert.equal(repo.git('rev-parse', 'HEAD'), before);
});

test('it refuses and changes nothing when the PR is not merged or the checkout is not a clean stacked branch', async t => {
  const cases = [
    ['an open PR', { state: 'OPEN' }, () => {}, /PR #1 is OPEN, not MERGED/],
    ['a dirty tree', {}, repo => write(repo.w, 'b', ['dirty']), /working tree has changes/],
    ['a detached HEAD', {}, repo => repo.git('switch', '-q', '--detach'), /HEAD is detached/],
    ['the base branch', {}, repo => repo.git('switch', '-q', 'main'), /HEAD is on main/],
    ['a branch off main', {}, repo => repo.git('switch', '-q', '-c', 'plain', 'main'), /was not stacked on it, or it is already restacked/],
  ];
  for (const [name, options, arrange, message] of cases) {
    await t.test(name, st => {
      const repo = stackedRepo(st, options);
      arrange(repo);
      const before = repo.git('rev-parse', 'HEAD');
      const result = repo.restack('1');
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
      assert.equal(repo.git('rev-parse', 'HEAD'), before);
    });
  }
});

test('a second run on a restacked branch refuses', t => {
  const repo = stackedRepo(t);
  assert.equal(repo.restack('1').status, 0);
  const result = repo.restack('1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already restacked/);
});

test('a missing or extra argument prints the usage and exits 2', () => {
  for (const args of [[], ['abc'], ['1', '2'], ['1', '--bogus']]) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /usage: node scripts\/restack-after-squash\.mjs/);
  }
});

test('shellWord keeps spaces, apostrophes, $, $() and backticks literal in sh', () => {
  for (const value of ['plain/branch', 'a b', "it's", '$HOME', '$(touch pwned)', '`id`', '--force-with-lease=x:$(y)']) {
    assert.equal(execFileSync('sh', ['-c', `printf %s ${shellWord(value)}`], { encoding: 'utf8' }), value);
  }
});
