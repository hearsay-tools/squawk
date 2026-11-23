import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const FILE_DURATION_LIMIT_MS = 60_000;
// Every shard warns at 80% of the hard cap, even outside a PR selection.
export const FILE_DURATION_WARNING_MS = FILE_DURATION_LIMIT_MS * 0.8;
// PR runs only: a file the PR changes fails at this limit, any other file warns.
export const FILE_DURATION_SOFT_LIMIT_MS = 45_000;
// The shard slowdown needs this many weighted files; with fewer it is 1.
export const SLOWDOWN_MIN_FILES = 10;
export const SLOWDOWN_MAX = 3;
// The failed-file list a merge-group rerun reads (vitest-rerun-reset.cjs): a file over the cap
// passes its tests, so Vitest's results cache does not mark it failed.
export const CAP_FAILURES_FILE = join('node_modules', '.vite', 'vitest', 'file-duration-cap.txt');
const OWNER = '.github/scripts/vitest-file-duration.mjs';
const HARD = `hard limit ${FILE_DURATION_LIMIT_MS} ms (FILE_DURATION_LIMIT_MS in ${OWNER})`;
const WARNING = `warning threshold ${FILE_DURATION_WARNING_MS} ms (80% of ${HARD})`;
const SOFT = `soft limit ${FILE_DURATION_SOFT_LIMIT_MS} ms (FILE_DURATION_SOFT_LIMIT_MS in ${OWNER})`;

function manifestDurations() {
  return JSON.parse(readFileSync(new URL('../test-durations.json', import.meta.url), 'utf8')).durationsMs;
}

/** The shard's slowdown: median of measured / manifest weight, clamped to [1, SLOWDOWN_MAX]. */
export function shardSlowdown(measured, weights) {
  const ratios = measured
    .filter(({ file, duration }) => weights[file] > 0 && Number.isFinite(weights[file]) && duration > 0)
    .map(({ file, duration }) => duration / weights[file])
    .sort((a, b) => a - b);
  if (ratios.length < SLOWDOWN_MIN_FILES) return 1;
  const middle = ratios.length >> 1;
  const median = ratios.length % 2 ? ratios[middle] : (ratios[middle - 1] + ratios[middle]) / 2;
  return Math.min(SLOWDOWN_MAX, Math.max(1, median));
}

// GitHub workflow command encoding: data escapes %, CR and LF; properties also `:` and `,`.
const escapeData = text => text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const escapeProperty = text => escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
const annotation = (level, file, line) =>
  `::${level} file=${escapeProperty(file)},title=Vitest file duration cap::${escapeData(line)}`;

/** CI shard guard. Read live module execution time, including hooks and teardown. */
export default class FileDurationReporter {
  pending = new Set();
  results = [];
  failures = [];
  warnings = [];

  constructor({ durations, changedFilesList = process.env.VITEST_CHANGED_FILES } = {}) {
    this.durations = durations;
    this.changedFilesList = changedFilesList;
  }

  onInit(vitest) {
    this.root = vitest.config.root;
    this.list = join(vitest.config.root, CAP_FAILURES_FILE);
  }

  onTestRunStart() {
    this.pending.clear();
    this.results = [];
    this.failures = [];
    this.warnings = [];
    if (this.list) rmSync(this.list, { force: true });
  }

  onTestModuleCollected(module) {
    this.pending.add(module);
  }

  onTestModuleEnd(module) {
    this.pending.delete(module);
    const duration = module.diagnostic().duration;
    const completed = ['passed', 'failed', 'skipped'].includes(module.state()) && Number.isFinite(duration) && duration >= 0;
    this.results.push({ module, file: this.file(module), duration, completed });
  }

  file(module) {
    return relative(this.root ?? process.cwd(), module.moduleId).replaceAll('\\', '/');
  }

  changedFiles() {
    if (!this.changedFilesList) return undefined;
    return new Set(readFileSync(this.changedFilesList, 'utf8').split('\n').filter(Boolean));
  }

  onTestRunEnd() {
    for (const module of this.pending) this.results.push({ module, file: this.file(module), duration: 'unmeasured', completed: false });
    const done = this.results.filter(result => result.completed);
    const slowdown = shardSlowdown(done, this.durations ?? manifestDurations());
    const changed = this.changedFiles();
    for (const { module, file, duration, completed } of this.results) {
      if (!completed) {
        this.failures.push({ module, file, line: `${file}: no completed result (${duration} ms); ${HARD}` });
        continue;
      }
      const scaled = Math.round(duration / slowdown);
      const measured = `${file}: ${duration} ms (${scaled} ms at shard slowdown x${slowdown.toFixed(2)})`;
      if (scaled >= FILE_DURATION_LIMIT_MS) this.failures.push({ module, file, line: `${measured}; ${HARD}` });
      else if (changed && scaled >= FILE_DURATION_SOFT_LIMIT_MS) {
        if (changed.has(file)) this.failures.push({ module, file, line: `${measured}; ${SOFT}; the PR changes this file` });
        else this.warnings.push({ file, line: `${measured}; ${SOFT}; warning only: the PR does not change this file` });
      } else if (scaled >= FILE_DURATION_WARNING_MS) {
        this.warnings.push({ file, line: `${measured}; ${WARNING}; warning only` });
      }
    }
    this.report();
  }

  report() {
    for (const { file, line } of this.failures) console.log(annotation('error', file, line));
    for (const { file, line } of this.warnings) console.log(annotation('warning', file, line));
    if (this.warnings.length) console.warn(`Vitest file duration warnings:\n${this.warnings.map(item => item.line).join('\n')}`);
    if (!this.failures.length) return;
    console.error(`Vitest file duration cap failed:\n${this.failures.map(item => item.line).join('\n')}`);
    process.exitCode = 1;
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Vitest file duration cap failed\n\n${this.failures.map(item => `- ${item.line}`).join('\n')}\n`);
    }
    if (this.list) {
      mkdirSync(join(this.list, '..'), { recursive: true });
      writeFileSync(this.list, this.failures.map(item => `${item.module.moduleId}\n`).join(''));
    }
  }
}
