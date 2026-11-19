#!/usr/bin/env node
// Scan Git data with trusted tooling; never load a candidate's config or scripts.
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parse } = require('@babel/parser');

const git = (cwd, args, options = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', ...options });
const eligible = (name) => /^packages\/[^/]+\/src\//.test(name) || name.startsWith('packages/cezar/scripts/');

const crossPackageExceptions = [{
  files: ['packages/cezar/src/lint/wait-baseline.ts', 'packages/web/src/test/wait-baseline.ts'],
  reason: 'The cockpit unit wait rule moved into lint in hearsay-tools/cezarion#2421; the browser wait discipline, M08, stays in packages/web and may not import packages/cezar by relative path; remove this entry when M08 moves into lint.',
}];

/** All scan inputs are trusted paths materialized under packages/<workspace>/. */
function packageOf(root, name) {
  const relative = path.relative(root, name).split(path.sep);
  if (relative[0] !== 'packages' || !relative[1]) throw new Error('Clone report contains a path outside the scanned packages');
  return relative[1];
}

function materialize(repo, ref, scratch) {
  fs.rmSync(path.join(scratch, 'packages'), { recursive: true, force: true });
  fs.mkdirSync(path.join(scratch, 'packages'));
  const entries = git(repo, ['ls-tree', '-r', '-z', ref]).split('\0').filter(Boolean)
    .map((row) => { const tab = row.indexOf('\t'); const meta = row.slice(0, tab).split(' '); return { mode: meta[0], oid: meta[2], name: row.slice(tab + 1) }; })
    .filter(({ mode, name }) => mode.startsWith('100') && eligible(name));
  if (!entries.length) return;
  // One batch avoids a process for each source file. No checkout, symlinks or attributes.
  const blobs = git(repo, ['cat-file', '--batch'], {
    input: entries.map(({ oid }) => oid).join('\n') + '\n', encoding: null, maxBuffer: 128 * 1024 * 1024,
  });
  let offset = 0;
  for (const { name } of entries) {
    const end = blobs.indexOf(10, offset);
    const size = Number(blobs.subarray(offset, end).toString().split(' ')[2]);
    const target = path.join(scratch, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, blobs.subarray(end + 1, end + 1 + size));
    offset = end + size + 2;
  }
}

function scan(scratch, updateBaseline) {
  const baseline = path.join(scratch, 'baseline.json');
  fs.rmSync(path.join(scratch, 'report'), { recursive: true, force: true });
  const result = spawnSync(path.resolve(__dirname, '../../node_modules/.bin/jscpd'), [
    'packages', '--config', path.join(scratch, 'trusted-config.json'), '--no-gitignore', '--absolute', '--no-colors', '--no-tips',
    '--min-tokens', '50', '--min-lines', '5', '--format', 'typescript,tsx,javascript,jsx',
    '--ignore', '**/*.test.*,**/*.testkit.*,**/*.e2e.*,**/__fixtures__/**,**/fixtures/**',
    '--baseline', baseline, ...(updateBaseline ? ['--update-baseline'] : []),
    '--reporters', 'json', '--output', path.join(scratch, 'report'),
  ], { cwd: scratch, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`jscpd failed (${result.status}): ${result.stderr || result.stdout}`);
  const report = JSON.parse(fs.readFileSync(path.join(scratch, 'report/jscpd-report.json'), 'utf8'));
  if (!Array.isArray(report.duplicates)) throw new Error('Invalid clone report');
  return report.duplicates;
}

function relativeFile(scratch, file) {
  packageOf(scratch, file.name);
  if (!Number.isSafeInteger(file.start) || file.start < 1) throw new Error('Invalid clone location');
  return path.relative(scratch, file.name).split(path.sep).join('/');
}

// A module source: the string or plain template of an import, export, import(), import type,
// import = require() or require() call. Only these nodes name a module; other strings never do.
function sourceOf(node) {
  if (/^(?:Import|ExportNamed|ExportAll)Declaration$|^(?:ImportExpression|TSImportType)$/.test(node.type)) return node.source;
  if (node.type === 'TSExternalModuleReference') return node.expression;
  if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') return node.arguments[0];
  return undefined;
}

function sourceText(node) {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
}

/** Each relative module source in a file: its string offsets and its text. Unparsable code has none. */
function relativeSources(name, text) {
  const extension = path.extname(name);
  const plugins = /^\.[mc]?ts$/.test(extension) ? ['typescript'] : extension === '.tsx' ? ['typescript', 'jsx'] : ['jsx'];
  let program;
  try {
    program = parse(text, { sourceType: 'module', plugins, errorRecovery: true, allowReturnOutsideFunction: true }).program;
  } catch {
    return [];
  }
  const found = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node.type !== 'string') return;
    const source = sourceOf(node);
    const value = sourceText(source);
    if (value !== undefined && /^\.\.?\//.test(value)) found.push({ start: source.start, end: source.end, value });
    for (const [key, child] of Object.entries(node)) if (key !== 'loc' && child && typeof child === 'object') visit(child);
  };
  visit(program);
  return found;
}

function lineStart(text, line) {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const end = text.indexOf('\n', offset);
    if (end < 0) return -1;
    offset = end + 1;
  }
  return offset;
}

/**
 * Record on each clone the relative module sources inside its fragment, found by parsing the first
 * file the fragment was cut from. jscpd cuts the fragment from the start of the first file's start
 * line. Run it while the scanned tree is on disk.
 */
function withModuleSources(scratch, clones) {
  const files = new Map();
  for (const clone of clones) {
    const name = relativeFile(scratch, clone.firstFile);
    if (!files.has(name)) {
      const text = fs.readFileSync(path.join(scratch, name), 'utf8');
      files.set(name, { text, sources: relativeSources(name, text) });
    }
    const { text, sources } = files.get(name);
    const offset = lineStart(text, clone.firstFile.start);
    const cut = typeof clone.fragment === 'string' && offset >= 0 && text.startsWith(clone.fragment, offset);
    clone.moduleSources = cut ? sources.filter(({ start, end }) => start >= offset && end <= offset + clone.fragment.length)
      .map(({ start, end, value }) => ({ start: start - offset, end: end - offset, value })) : [];
  }
  return clones;
}

// The clone's code with its layout dropped, its token count and its package: the same clone in
// another file or file pair hashes alike, so a move can be told from a new copy. Each relative
// module source reads as the repository path it resolves to from the first file, marked so no other
// string reads alike, so a moved file that still imports the same modules keeps its fingerprint.
function fingerprint(scratch, clone) {
  if (typeof clone.fragment !== 'string' || !Number.isSafeInteger(clone.tokens)) throw new Error('Invalid clone fragment');
  const folder = path.posix.dirname(relativeFile(scratch, clone.firstFile));
  let resolved = clone.fragment;
  for (const { start, end, value } of [...(clone.moduleSources ?? [])].sort((a, b) => b.start - a.start)) {
    resolved = `${resolved.slice(0, start)}\0${JSON.stringify(path.posix.join(folder, value))}${resolved.slice(end)}`;
  }
  const text = resolved.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
  return crypto.createHash('sha256').update(`${packageOf(scratch, clone.firstFile.name)}\0${clone.tokens}\0${text}`).digest('hex');
}

const pairKey = (scratch, clone) => JSON.stringify([relativeFile(scratch, clone.firstFile), relativeFile(scratch, clone.secondFile)].sort());
const samePackage = (scratch, clone) => packageOf(scratch, clone.firstFile.name) === packageOf(scratch, clone.secondFile.name);

/**
 * Drop each head clone that a merge-base clone with the same fingerprint carries over, one for one,
 * from both scans: code that moved with its clone, to another file or file pair, is not a new clone.
 * A clone that stays in its pair is carried first, so a new copy is reported where it was added.
 * A further copy finds no free merge-base clone and stays. Cross-package clones are never carried.
 */
function carryMoved(scratch, baseline, head) {
  const free = new Map();
  for (const clone of baseline.filter(item => samePackage(scratch, item))) {
    const key = fingerprint(scratch, clone);
    free.set(key, [...(free.get(key) ?? []), clone]);
  }
  const carried = new Set();
  const take = (clone, match) => {
    const candidates = free.get(fingerprint(scratch, clone)) ?? [];
    const index = candidates.findIndex(match);
    if (index < 0) return;
    carried.add(candidates[index]).add(clone);
    candidates.splice(index, 1);
  };
  const movable = head.filter(item => samePackage(scratch, item));
  for (const clone of movable) take(clone, item => pairKey(scratch, item) === pairKey(scratch, clone));
  for (const clone of movable.filter(item => !carried.has(item))) take(clone, () => true);
  return { baseline: baseline.filter(item => !carried.has(item)), head: head.filter(item => !carried.has(item)) };
}

function summarize(scratch, duplicates) {
  const pairs = new Map();
  const forbidden = [];
  const sameFiles = new Map();
  for (const clone of duplicates) {
    const { firstFile, secondFile, tokens, isNew } = clone;
    const first = relativeFile(scratch, firstFile);
    const second = relativeFile(scratch, secondFile);
    if (!Number.isSafeInteger(tokens) || tokens <= 0 || typeof isNew !== 'boolean') throw new Error('Invalid clone accounting');
    const location = `${first}:${firstFile.start} ↔ ${second}:${secondFile.start}`;
    if (packageOf(scratch, firstFile.name) !== packageOf(scratch, secondFile.name)) {
      const excepted = crossPackageExceptions.some(({ files }) =>
        files.includes(first) && files.includes(second));
      if (!excepted) forbidden.push(`Cross-package clone: ${location}`);
    } else if (first === second) {
      const file = sameFiles.get(first) || { tokens: 0, location };
      file.tokens += tokens;
      sameFiles.set(first, file);
    } else {
      const key = JSON.stringify([first, second].sort());
      const pair = pairs.get(key) || { tokens: 0, location };
      pair.tokens += tokens;
      pairs.set(key, pair);
    }
  }
  return { pairs, sameFiles, forbidden };
}

function compare(baseline, head) {
  const failures = [...head.forbidden];
  for (const [key, pair] of head.pairs) {
    const previous = baseline.pairs.get(key);
    if (!previous || pair.tokens > previous.tokens) {
      failures.push(`Clone token increase: ${pair.location} (baseline ${previous?.tokens ?? 0}, head ${pair.tokens} tokens)`);
    }
  }
  for (const [name, file] of head.sameFiles) {
    const previous = baseline.sameFiles.get(name);
    if (!previous) {
      failures.push(`New same-file clone: ${file.location}`);
    } else if (file.tokens > previous.tokens) {
      failures.push(`Clone token increase: ${file.location} (baseline ${previous.tokens}, head ${file.tokens} tokens)`);
    }
  }
  return failures;
}

function check({ repo = process.cwd(), base = 'origin/main', head = 'HEAD' } = {}) {
  const mergeBase = git(repo, ['merge-base', base, head]).trim();
  const headSha = git(repo, ['rev-parse', '--verify', `${head}^{commit}`]).trim();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cezar-clones-'));
  try {
    // Both scans use the same trusted paths and options; candidate config never runs.
    fs.writeFileSync(path.join(scratch, 'trusted-config.json'), '{}');
    materialize(repo, mergeBase, scratch);
    const baseClones = withModuleSources(scratch, scan(scratch, true));
    materialize(repo, headSha, scratch);
    const kept = carryMoved(scratch, baseClones, withModuleSources(scratch, scan(scratch, false)));
    const baseline = summarize(scratch, kept.baseline);
    const headReport = summarize(scratch, kept.head);
    const failures = compare(baseline, headReport);
    for (const failure of failures) process.stdout.write(`${failure}\n`);
    process.stdout.write(`Clone pairs: ${headReport.pairs.size}; violations: ${failures.length}\n`);
    return failures.length ? 1 : 0;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--base', '--head'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: check-clones.cjs [--base REF] [--head REF]');
    options[args[i].slice(2)] = args[i + 1];
  }
  process.exitCode = check(options);
}
module.exports = { check, eligible, summarize, compare, carryMoved, withModuleSources };
