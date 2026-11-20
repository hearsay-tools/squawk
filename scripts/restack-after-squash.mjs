#!/usr/bin/env node
// Restack a branch that started on the head of an open pull request after that pull request was
// squash-merged (hearsay-tools/squawk#3970). Git reads the base's commits and the squash commit as
// different changes, so a plain merge or rebase of `origin/<base>` conflicts in files the branch
// never changed. This replays only the branch's own commits, or merges with the base's final head
// as the merge base. docs/areas/git-worktree.md § Stacked and overlapping branches says when to
// run it.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = 'usage: node scripts/restack-after-squash.mjs <base PR number> [--merge] [--dry-run]';

/** Quotes one POSIX shell word; a local copy of `shellQuote` (packages/cezar/src/core/shell-env.ts). */
export function shellWord(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

class Refusal extends Error {}

function refuse(message) {
  throw new Refusal(message);
}

/** Inherited from a Git hook or a `rebase --exec` step, these would make Git ignore `cwd`. */
const GIT_LOCATION_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX',
];

function makeRunner(cwd) {
  const env = { ...process.env };
  for (const name of GIT_LOCATION_VARS) delete env[name];
  return (command, args) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error?.code === 'ENOENT') refuse(`${command} is not installed or not on PATH; this command needs it.`);
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  };
}

function gitWith(run) {
  const git = (...args) => run('git', args);
  git.ok = (...args) => {
    const result = git(...args);
    if (result.status !== 0) refuse(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  git.isAncestor = (a, b) => git('merge-base', '--is-ancestor', a, b).status === 0;
  return git;
}

/**
 * The URL `git fetch origin` uses, after `url.<base>.insteadOf` rewrites. `gh --repo` accepts it in
 * every form Git does (HTTPS, SSH, scp-like), so the pull request and its refs come from one place.
 */
function originUrl(git) {
  return git.ok('remote', 'get-url', 'origin');
}

function readPullRequest(run, repo, pr) {
  const result = run('gh', ['pr', 'view', pr, '--repo', repo, '--json', 'state,headRefOid,baseRefName,mergeCommit']);
  if (result.status !== 0) refuse(`gh pr view ${pr} failed: ${result.stderr || result.stdout}`);
  const { state, headRefOid, baseRefName, mergeCommit } = JSON.parse(result.stdout);
  if (state !== 'MERGED') refuse(`PR #${pr} is ${state}, not MERGED. Restack after it is squash-merged.`);
  return { finalHead: headRefOid, base: baseRefName, squash: mergeCommit?.oid };
}

function checkWorktree(git, base) {
  const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
  if (branch.status !== 0) refuse('HEAD is detached. Switch to the stacked branch first.');
  if (branch.stdout === base) refuse(`HEAD is on ${base}. Switch to the stacked branch first.`);
  const busy = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']
    .find(name => existsSync(git.ok('rev-parse', '--path-format=absolute', '--git-path', name)));
  if (busy) refuse(`A Git operation is in progress (${busy}). Finish or abort it first.`);
  if (git.ok('status', '--porcelain')) refuse('The working tree has changes. Commit or stash them first.');
  return branch.stdout;
}

function checkStacked(git, { finalHead, upstream, squash, pr }) {
  if (squash && git.isAncestor(squash, 'HEAD')) {
    refuse(`This branch already contains PR #${pr}'s squash commit: it is restacked. Merge or rebase the base branch as usual from now on.`);
  }
  const fork = git('merge-base', 'HEAD', finalHead);
  if (fork.status !== 0 || git.isAncestor(fork.stdout, upstream)) {
    refuse(`This branch shares no unmerged commit with PR #${pr}'s final head: it was not stacked on it, or it is already restacked.`);
  }
  return fork.stdout;
}

/**
 * The branch's tip on origin, which the printed push lease expects; empty when it was never pushed.
 * A tip this branch does not contain holds work a force-push would delete, so it refuses first.
 */
function readRemoteHead(git, branch) {
  const remoteHead = git.ok('ls-remote', '--heads', 'origin', `refs/heads/${branch}`).split('\t')[0];
  if (remoteHead && !git.isAncestor(remoteHead, 'HEAD')) {
    refuse(`origin/${branch} (${remoteHead}) has commits this branch does not contain. Fetch and integrate them first, so the restack and its push keep them.`);
  }
  return remoteHead;
}

/**
 * The sorted lines of a diff without context, hunk positions and blob ids: equal for the same patch
 * on a different base. Mode changes and binary patches count, so a lost one reads as changed.
 */
function patchLines(git, from, to) {
  return git.ok('diff', '-U0', '--binary', '--no-color', '--no-ext-diff', from, to)
    .split('\n')
    .filter(line => !/^(?:@@|index )/.test(line))
    .sort()
    .join('\n');
}

/** `merge-tree --name-only` prints the tree, the conflicted paths, an empty line, then messages. */
function conflictedFiles(output) {
  const lines = output.split('\n').slice(1);
  const end = lines.indexOf('');
  return (end === -1 ? lines : lines.slice(0, end)).join(', ');
}

function rebase(git, ctx) {
  if (git.ok('rev-list', '--merges', `${ctx.finalHead}..HEAD`)) {
    refuse('The branch has merge commits after the base PR\'s final head. A rebase drops them, with any edit made in them. Use --merge.');
  }
  const result = git('rebase', '--onto', ctx.upstream, ctx.finalHead);
  if (result.status === 0) return;
  const files = git.ok('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean).join(', ');
  refuse(`The rebase stopped on a conflict in: ${files || 'unknown files'}. Resolve them and run git rebase --continue, or run git rebase --abort to return to ${ctx.oldHead}.`);
}

function mergeTree(git, args, what) {
  const result = git('merge-tree', '--write-tree', '--name-only', ...args);
  if (result.status === 1) refuse(`${what} conflicts in: ${conflictedFiles(result.stdout)}. Nothing was changed.`);
  if (result.status !== 0) refuse(`git merge-tree failed (it needs Git 2.40 or later): ${result.stderr}`);
  return result.stdout.split('\n')[0];
}

function merge(git, ctx) {
  let head = ctx.oldHead;
  if (!git.isAncestor(ctx.finalHead, head)) {
    const tree = mergeTree(git, [head, ctx.finalHead], `Merging PR #${ctx.pr}'s final head`);
    head = git.ok('commit-tree', tree, '-p', head, '-p', ctx.finalHead, '-m', `Merge the final head of #${ctx.pr}`);
  }
  const tree = mergeTree(git, [`--merge-base=${ctx.finalHead}`, head, ctx.upstream], `Merging ${ctx.upstreamRef}`);
  const merged = git.ok('commit-tree', tree, '-p', head, '-p', ctx.upstream, '-m', `Merge ${ctx.upstreamRef} after #${ctx.pr} was squash-merged`);
  git.ok('merge', '--ff-only', '--quiet', merged);
}

function report(git, ctx, mode) {
  const before = patchLines(git, ctx.fork, ctx.oldHead);
  const after = patchLines(git, ctx.upstream, 'HEAD');
  const lines = [before === after
    ? 'Own patch unchanged: no new review round is needed for the restack.'
    : `Own patch changed. Compare: git range-diff ${ctx.finalHead}..${ctx.oldHead} ${ctx.upstream}..HEAD`];
  lines.push(mode === 'merge'
    ? `Push: git push origin ${shellWord(`HEAD:${ctx.branch}`)}`
    : `Push: git push ${shellWord(`--force-with-lease=${ctx.branch}:${ctx.remoteHead}`)} origin ${shellWord(`HEAD:${ctx.branch}`)}`);
  return lines;
}

/** Runs the restack in `cwd`; returns the lines to print. Throws a Refusal when it changes nothing. */
export function restack({ cwd, pr, mode, dryRun }) {
  const run = makeRunner(cwd);
  const git = gitWith(run);
  const { finalHead, base, squash } = readPullRequest(run, originUrl(git), pr);
  const branch = checkWorktree(git, base);
  git.ok('fetch', '--quiet', 'origin', base, `pull/${pr}/head`);
  if (git('cat-file', '-e', `${finalHead}^{commit}`).status !== 0) refuse(`PR #${pr}'s final head ${finalHead} could not be fetched.`);
  const upstreamRef = `origin/${base}`;
  const upstream = git.ok('rev-parse', '--verify', `${upstreamRef}^{commit}`);
  const fork = checkStacked(git, { finalHead, upstream, squash, pr });
  const remoteHead = readRemoteHead(git, branch);
  const ctx = { pr, branch, finalHead, upstream, upstreamRef, fork, remoteHead, oldHead: git.ok('rev-parse', 'HEAD') };
  const own = git.ok('log', '--oneline', '--no-merges', `${finalHead}..HEAD`);
  const header = [`${branch}: own commits after PR #${pr}'s final head ${finalHead.slice(0, 12)}:`, own || '(none)'];
  if (dryRun) return [...header, `Dry run: nothing changed. Without --dry-run this ${mode === 'merge' ? 'merges' : 'rebases onto'} ${upstreamRef}.`];
  (mode === 'merge' ? merge : rebase)(git, ctx);
  return [...header, `Restacked onto ${upstreamRef} by ${mode}. Old head: ${ctx.oldHead}.`, ...report(git, ctx, mode)];
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { merge: { type: 'boolean' }, 'dry-run': { type: 'boolean' } } });
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  const [pr, ...rest] = parsed.positionals;
  if (!/^\d+$/.test(pr ?? '') || rest.length > 0) {
    console.error(USAGE);
    return 2;
  }
  try {
    const lines = restack({ cwd: process.cwd(), pr, mode: parsed.values.merge ? 'merge' : 'rebase', dryRun: Boolean(parsed.values['dry-run']) });
    console.log(lines.join('\n'));
    return 0;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(error.message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
