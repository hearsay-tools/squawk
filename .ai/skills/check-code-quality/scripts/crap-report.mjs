#!/usr/bin/env node
// CRAP for the functions a change touches, from CI's merged Vitest coverage (hearsay-tools/squawk#3702).
// The report never fails a check: CI shows it on the pull request and files the functions over the
// limit after the merge (`.github/workflows/crap-follow-up.yml`). The head is read as Git objects only.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { matchesGlob, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { scanChanges, thresholds } from './changed-functions.mjs';
import { analyzeSource } from './code-metrics.mjs';

const HELP = `Usage: node <skill>/scripts/crap-report.mjs --base <ref> --head <rev> --coverage <coverage-final.json>
       [--exclude-config <squeal.config.json>] [--json <file>] [--summary <file>]

Report CRAP for each function that <rev> changes since its merge-base with <ref>, from an
Istanbul coverage report whose paths are relative to the repository root. A function's
coverage is the share of the statements in its own body that ran; nested function bodies
count for the nested function. CRAP = complexity^2 * (1 - coverage)^3 + complexity.
A function over ${thresholds.crap} gets a warning. The report never fails: exit 0 once written,
2 when it could not be made.
`;

/** The CRAP score of a function with `complexity` and `coverage` (a fraction from 0 to 1). */
export const crapScore = (complexity, coverage) => complexity ** 2 * (1 - coverage) ** 3 + complexity;

/** Offsets where each 1-based line starts, so Istanbul's line and 0-based column map to an offset. */
function lineStarts(source) {
  const starts = [0, 0];
  for (let index = 0; index < source.length; index++) if (source[index] === '\n') starts.push(index + 1);
  return starts;
}

/**
 * Statement coverage of `fn`'s own body: the statements that start inside its body and outside
 * every nested function. `null` when the body holds no mapped statement.
 */
export function functionCoverage(fn, functions, entry, starts) {
  const nested = functions.filter(item => item.start > fn.start && item.end <= fn.end);
  let total = 0, covered = 0;
  for (const [id, location] of Object.entries(entry.statementMap ?? {})) {
    const at = (starts[location.start.line] ?? Infinity) + location.start.column;
    if (at < fn.bodyStart || at >= fn.bodyEnd || nested.some(item => at >= item.start && at < item.end)) continue;
    total++;
    if ((entry.s?.[id] ?? 0) > 0) covered++;
  }
  return total ? covered / total : null;
}

function excludePatterns(path) {
  if (!path) return [];
  const exclude = JSON.parse(readFileSync(path, 'utf8')).coverage?.exclude ?? [];
  if (!Array.isArray(exclude) || exclude.some(item => typeof item !== 'string')) throw new Error(`${path}: coverage.exclude must be a list of strings`);
  return exclude;
}

/**
 * The names of `fn` and every function around it, outermost first: two same-named helpers in different
 * functions differ. An anonymous function's position is dropped, as changed-functions.mjs drops it, so
 * the scope survives a line moving above it.
 */
const scopeOf = (fn, functions) => functions.filter(item => item.start <= fn.start && item.end >= fn.end)
  .map(item => item.name.replace(/^anonymous@\d+:\d+$/, 'anonymous')).join(' / ');

/** One row per changed function: `over`, `pass`, `excluded` (child-process-only code) or `no-coverage`. */
export function scoreChanges(scan, coverage, { exclude = [], read, limit = thresholds.crap } = {}) {
  return scan.files.flatMap(({ file, functions: changed }) => {
    const source = read(file);
    const functions = analyzeSource(source, file);
    const starts = lineStarts(source);
    const excluded = exclude.some(pattern => matchesGlob(file, pattern));
    const entry = coverage[file];
    return changed.map(fn => {
      const located = functions.find(item => item.line === fn.line && item.column === fn.column);
      const row = status => ({ file, name: fn.name, scope: located ? scopeOf(located, functions) : fn.name, line: fn.line, complexity: fn.complexity, coverage: null, crap: null, status });
      if (excluded) return row('excluded');
      const share = entry && located ? functionCoverage(located, functions, entry, starts) : null;
      if (share === null) return row('no-coverage');
      const crap = crapScore(fn.complexity, share);
      return { ...row(crap > limit ? 'over' : 'pass'), coverage: share, crap };
    });
  });
}

const percent = share => (share === null ? '—' : `${Math.round(share * 100)}%`);
const score = crap => (crap === null ? '—' : crap.toFixed(1));
const STATUS = { over: 'over the limit', pass: 'pass', excluded: 'excluded (child process only)', 'no-coverage': 'no coverage data' };
const cell = text => String(text).replaceAll('|', '\\|');

export function summaryMarkdown(report) {
  const { functions, limit } = report;
  const over = functions.filter(fn => fn.status === 'over').length;
  const lines = [
    '## CRAP for changed functions',
    '',
    `${functions.length} changed ${functions.length === 1 ? 'function' : 'functions'}; ${over} over ${limit}. This report never fails a check. ` +
      'After the merge, each function over the limit gets a line in the open `crap-follow-up` issue.',
    '',
    `Coverage: \`${report.coverageArtifact ?? 'the merged Vitest coverage'}\`, tested commit \`${report.head}\`.`,
  ];
  if (!functions.length) return [...lines, ''].join('\n');
  lines.push('', '| Function | Complexity | Coverage | CRAP | Status |', '| --- | ---: | ---: | ---: | --- |');
  const order = { over: 0, pass: 1, 'no-coverage': 2, excluded: 3 };
  for (const fn of [...functions].sort((a, b) => order[a.status] - order[b.status] || (b.crap ?? 0) - (a.crap ?? 0))) {
    lines.push(`| \`${cell(fn.file)}:${fn.line}\` ${cell(fn.name)} | ${fn.complexity} | ${percent(fn.coverage)} | ${score(fn.crap)} | ${STATUS[fn.status]} |`);
  }
  return [...lines, ''].join('\n');
}

const escapeData = text => text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const escapeProperty = text => escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
export const warningLine = (fn, limit) =>
  `::warning file=${escapeProperty(fn.file)},line=${fn.line},title=CRAP over ${limit}::${escapeData(`${fn.name}: CRAP ${score(fn.crap)} (complexity ${fn.complexity}, coverage ${percent(fn.coverage)}; limit ${limit})`)}`;

export function runCrapReport(args, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      base: { type: 'string' }, head: { type: 'string' }, coverage: { type: 'string' }, 'exclude-config': { type: 'string' },
      json: { type: 'string' }, summary: { type: 'string' }, artifact: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) { stdout.write(HELP); return 0; }
    if (!values.base?.trim() || !values.head?.trim() || !values.coverage || positionals.length) {
      throw new Error('Supply --base <ref>, --head <rev> and --coverage <coverage-final.json>.');
    }
    const coverage = JSON.parse(readFileSync(resolve(cwd, values.coverage), 'utf8'));
    const exclude = excludePatterns(values['exclude-config'] && resolve(cwd, values['exclude-config']));
    const scan = scanChanges(values.base, cwd, { head: values.head });
    const read = file => execFileSync('git', ['show', '--no-textconv', `${scan.head}:${file}`], {
      cwd: scan.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    });
    const limit = thresholds.crap;
    const report = {
      schemaVersion: 1, base: scan.base, head: scan.head, limit, coverageArtifact: values.artifact ?? null,
      functions: scoreChanges(scan, coverage, { exclude, read, limit }),
    };
    if (values.json) writeFileSync(resolve(cwd, values.json), `${JSON.stringify(report, null, 2)}\n`);
    const markdown = summaryMarkdown(report);
    if (values.summary) writeFileSync(resolve(cwd, values.summary), markdown);
    const warnings = report.functions.filter(fn => fn.status === 'over').map(fn => warningLine(fn, limit));
    stdout.write([markdown, ...warnings, ''].join('\n'));
    return 0;
  } catch (error) {
    stderr.write(`crap-report: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runCrapReport(process.argv.slice(2));
}
