// Trusted CI code: inspect Git blobs as JSON/text; never load code from the head.
const { execFileSync } = require('node:child_process');

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const stays = () => false;

// Match each head item to a distinct base item it fits. Matching can reassign a prior
// choice, so the order of the items never decides whether a one-for-one match exists.
// Returns the head items left without one.
function unmatched(before, after, fits) {
  const owners = new Map();
  function assign(index, seen) {
    for (let i = 0; i < before.length; i++) {
      if (seen.has(i) || !fits(before[i], after[index])) continue;
      seen.add(i);
      if (!owners.has(i) || assign(owners.get(i), seen)) {
        owners.set(i, index);
        return true;
      }
    }
    return false;
  }
  return after.filter((_, i) => !assign(i, new Set()));
}

// Arrays are multisets: each head entry must fit a distinct base entry, so reordered
// duplicate sites with different counts do not report growth. Object keys and numeric
// limits may only shrink.
function arrayFits(before, after, moved) {
  return !unmatched(before, after, (old, entry) => !compareBaseline(old, entry, '$', moved).length).length;
}

/**
 * The ways `after` grew past `before`. `moved(oldPath, newPath)` says a file moved: a string or key
 * that names it may then name its new path, one for one, and is not growth.
 */
function compareBaseline(before, after, location = '$', moved = stays) {
  if (typeof before === 'number' && typeof after === 'number') {
    return after <= before ? [] : [`${location}: number grew from ${before} to ${after}`];
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    return arrayFits(before, after, moved) ? [] : [`${location}: added or enlarged an entry`];
  }
  if (object(before) && object(after)) {
    const keys = Object.keys(after).filter(key => key !== '$comment');
    // A key the head adds may take over one key the head dropped: a pin keyed by the path of a moved file.
    const dropped = Object.keys(before).filter(key => !Object.hasOwn(after, key));
    const added = unmatched(dropped, keys.filter(key => !Object.hasOwn(before, key)),
      (old, key) => moved(old, key) && !compareBaseline(before[old], after[key], '$', moved).length);
    return keys.flatMap(key => Object.hasOwn(before, key)
      ? compareBaseline(before[key], after[key], `${location}.${key}`, moved)
      : added.includes(key) ? [`${location}.${key}: added an entry`] : []);
  }
  if (typeof before === 'string' && typeof after === 'string' && moved(before, after)) return [];
  return before === after ? [] : [`${location}: changed an entry or its type`];
}

const PATH = /[\w.@-]+(?:\/[\w.@-]+)*/g;

/**
 * Whether `after` is `before` with one path it names moved: the old file is gone from the head and
 * the change added the new one. A baseline may name a file by its full path or by its path below a
 * directory both files share (`routes/x.tsx` under `packages/web/src/`), alone or inside a longer
 * string (`routes/x.tsx: <source>`).
 */
function movedBetween(baseFiles, headFiles) {
  const base = new Set(baseFiles), head = new Set(headFiles);
  const added = new Set(headFiles.filter(file => !base.has(file)));
  const gone = new Map(); // Each tail of a removed path, with the directory above it.
  for (const file of baseFiles.filter(file => !head.has(file))) {
    const segments = file.split('/');
    for (let k = 0; k < segments.length; k++) {
      const tail = segments.slice(k).join('/');
      gone.set(tail, [...(gone.get(tail) ?? []), segments.slice(0, k).join('/')]);
    }
  }
  return (before, after) => {
    if (before === after) return false;
    for (const { 0: tail, index } of before.matchAll(PATH)) {
      const rest = before.length - index - tail.length;
      if (after.slice(0, index) !== before.slice(0, index) || after.slice(after.length - rest) !== before.slice(before.length - rest)) continue;
      const tailAfter = after.slice(index, after.length - rest);
      if ((gone.get(tail) ?? []).some(dir => added.has(dir ? `${dir}/${tailAfter}` : tailAfter))) return true;
    }
    return false;
  };
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20, stdio: 'pipe' });
}

function tree(cwd, rev) {
  return git(cwd, 'ls-tree', '-r', '--name-only', '-z', rev).split('\0').filter(Boolean);
}

function readBaseline(cwd, rev, file) {
  return JSON.parse(git(cwd, 'show', `${rev}:${file}`));
}

// Conservative literal-reader scan, including test helpers and scripts. A source
// reference to a removed basename must go too; comments can also block deletion.
// This is static evidence, not execution or a proof about computed filenames.
function deletedReaders(cwd, head, deleted) {
  const patterns = deleted.flatMap(file => ['-e', file.slice(file.lastIndexOf('/') + 1)]);
  try {
    return git(cwd, 'grep', '-I', '-l', '-z', '-F', ...patterns, head, '--',
      '*.js', '*.cjs', '*.mjs', '*.jsx', '*.ts', '*.cts', '*.mts', '*.tsx')
      .split('\0').filter(Boolean).map(file => file.slice(head.length + 1));
  } catch (error) {
    if (error.status === 1) return []; // No literal readers remain.
    throw error;
  }
}

function checkBaselineGrowth({ cwd = process.cwd(), base, head, allowGrowth = false }) {
  const baseFiles = tree(cwd, base);
  const beforeFiles = baseFiles.filter(file => file.endsWith('.baseline.json'));
  const headFiles = tree(cwd, head);
  const afterFiles = new Set(headFiles.filter(file => file.endsWith('.baseline.json')));
  const moved = movedBetween(baseFiles, headFiles);
  const reasons = [];
  for (const file of afterFiles) {
    const after = readBaseline(cwd, head, file); // New and overridden files must still be valid JSON.
    if (!beforeFiles.includes(file)) continue; // A new file starts a new ratchet.
    const changes = compareBaseline(readBaseline(cwd, base, file), after, '$', moved);
    if (!allowGrowth) reasons.push(...changes.map(change => `${file}: ${change}`));
  }
  const deleted = beforeFiles.filter(file => !afterFiles.has(file));
  if (deleted.length) {
    reasons.push(...deletedReaders(cwd, head, deleted)
      .map(file => `deleted baseline still referenced by ${file}`));
  }
  return reasons;
}

// Called only after the workflow checks out the trusted base. The head is fetched into the
// object store and is never checked out. Returns the live PR, the fetched head and the merge
// base to measure from, or undefined for an event that has no PR to check.
async function resolvePullRequest({ github, context, cwd = process.cwd() }) {
  const dispatched = context.eventName === 'workflow_dispatch';
  if (context.eventName !== 'pull_request_target' && !dispatched) return undefined;
  const number = dispatched ? Number(context.payload.inputs.pr_number) : context.payload.pull_request.number;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid PR number');
  const expectedHead = dispatched ? context.sha : context.payload.pull_request.head.sha;
  const base = dispatched ? git(cwd, 'rev-parse', 'HEAD').trim() : context.payload.pull_request.base.sha;
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
  if (pr.head.sha !== expectedHead || pr.base.sha !== base) throw new Error('PR changed; rerun CI for the current head/base');
  git(cwd, 'fetch', '--no-tags', 'origin', expectedHead);
  const fetched = git(cwd, 'rev-parse', 'FETCH_HEAD').trim();
  const { data: current } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
  if (fetched !== expectedHead || current.head.sha !== expectedHead || current.base.sha !== base) throw new Error('PR changed during fetch; rerun CI');
  // GitHub never moves the event's base.sha when the base branch advances. Measure from the
  // branch tip this workflow runs from, so commits the head took from that branch stay out.
  const mergeBase = git(cwd, 'merge-base', dispatched ? base : context.sha, fetched).trim();
  return { pr, head: fetched, mergeBase };
}

// Live metadata supplies the label.
async function checkPullRequest({ github, context, core, cwd = process.cwd() }) {
  const resolved = await resolvePullRequest({ github, context, cwd });
  if (!resolved) return;
  const { pr, head, mergeBase } = resolved;
  const allowGrowth = pr.labels.some(label => label.name === 'baseline-growth');
  const reasons = checkBaselineGrowth({ cwd, base: mergeBase, head, allowGrowth });
  if (reasons.length) core.setFailed(`${reasons.join('\n')}\nFor an owner-approved increase, add the baseline-growth label, then re-run the failed classify-pr job. Deletion readers and invalid JSON must still be fixed. A pin that only follows a file this change moved needs no label: keep its other fields (docs/areas/packages.md § Moving a source file).`);
  else core.info(allowGrowth ? 'Baseline growth approved by label; owner merge required.' : 'Baseline ratchets did not grow.');
}

module.exports = { compareBaseline, movedBetween, checkBaselineGrowth, resolvePullRequest, checkPullRequest };
