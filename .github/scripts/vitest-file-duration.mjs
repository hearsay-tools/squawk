import { subscribe } from 'node:diagnostics_channel';
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
// passes its tests, and a file whose worker died has no result, so Vitest's results cache marks
// neither failed.
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
const annotation = (level, file, line, title = 'Vitest file duration cap') =>
  `::${level} file=${escapeProperty(file)},title=${escapeProperty(title)}::${escapeData(line)}`;
const UNFINISHED = 'Vitest test files that did not finish';
// The script a Vitest fork worker runs (vitest/dist/workers/forks.js and its siblings).
const WORKER_SCRIPT = /[\\/]vitest[\\/]dist[\\/]workers[\\/][\w-]+\.js$/;

/**
 * Vitest reports a worker that dies as "Worker exited unexpectedly" and drops its exit code and
 * signal. Node announces every child process on the `child_process` channel, so the reporter
 * reads them itself. Vitest stops its own workers with kill(), which marks them `killed`.
 */
export function watchWorkerExits(onExit) {
  subscribe('child_process', ({ process: child }) => {
    child.once('exit', (code, signal) => {
      if (!child.killed && child.spawnargs?.some(arg => WORKER_SCRIPT.test(arg))) onExit({ pid: child.pid, code, signal });
    });
  });
}

/** CI shard guard. Read live module execution time, including hooks and teardown. */
export default class FileDurationReporter {
  // Every file the run planned, by project and module, until its end event.
  pending = new Map();
  results = [];
  failures = [];
  warnings = [];
  unfinished = [];
  exits = [];

  constructor({ durations, changedFilesList = process.env.VITEST_CHANGED_FILES } = {}) {
    this.durations = durations;
    this.changedFilesList = changedFilesList;
  }

  onInit(vitest) {
    this.vitest = vitest;
    this.root = vitest.config.root;
    this.list = join(vitest.config.root, CAP_FAILURES_FILE);
    if (!this.watching) watchWorkerExits(exit => this.exits.push(exit));
    this.watching = true;
  }

  /** @param {ReadonlyArray<{ project: { name: string }, moduleId: string }>} [specifications] */
  async onTestRunStart(specifications = []) {
    this.pending.clear();
    this.results = [];
    this.failures = [];
    this.warnings = [];
    this.unfinished = [];
    this.exits = [];
    if (this.list) rmSync(this.list, { force: true });
    for (const specification of await this.shardOf(specifications)) this.plan(specification);
  }

  // Vitest reports every file of the run before the pool keeps this shard's part, so the
  // reporter asks the configured sequencer for the same part.
  shardOf(specifications) {
    const config = this.vitest?.config;
    if (!config?.shard) return specifications;
    return new config.sequence.sequencer(this.vitest).shard([...specifications]);
  }

  // A worker that dies before its file is collected leaves only the planned specification.
  plan({ project, moduleId }) {
    this.pending.set(`${project.name}\0${moduleId}`, moduleId);
  }

  onTestModuleCollected(module) {
    this.plan(module);
  }

  onTestModuleEnd(module) {
    this.pending.delete(`${module.project.name}\0${module.moduleId}`);
    const duration = module.diagnostic().duration;
    const completed = ['passed', 'failed', 'skipped'].includes(module.state()) && Number.isFinite(duration) && duration >= 0;
    this.results.push({ moduleId: module.moduleId, file: this.file(module.moduleId), duration, completed });
  }

  file(moduleId) {
    return relative(this.root ?? process.cwd(), moduleId).replaceAll('\\', '/');
  }

  changedFiles() {
    if (!this.changedFilesList) return undefined;
    return new Set(readFileSync(this.changedFilesList, 'utf8').split('\n').filter(Boolean));
  }

  onTestRunEnd() {
    for (const moduleId of new Set(this.pending.values())) {
      const file = this.file(moduleId);
      this.unfinished.push({ moduleId, file, line: `${file}: did not finish; the run ended before the file reported a result` });
    }
    const done = this.results.filter(result => result.completed);
    const slowdown = shardSlowdown(done, this.durations ?? manifestDurations());
    const changed = this.changedFiles();
    for (const { moduleId, file, duration, completed } of this.results) {
      if (!completed) {
        this.failures.push({ moduleId, file, line: `${file}: no completed result (${duration} ms); ${HARD}` });
        continue;
      }
      const scaled = Math.round(duration / slowdown);
      const measured = `${file}: ${duration} ms (${scaled} ms at shard slowdown x${slowdown.toFixed(2)})`;
      if (scaled >= FILE_DURATION_LIMIT_MS) this.failures.push({ moduleId, file, line: `${measured}; ${HARD}` });
      else if (changed && scaled >= FILE_DURATION_SOFT_LIMIT_MS) {
        if (changed.has(file)) this.failures.push({ moduleId, file, line: `${measured}; ${SOFT}; the PR changes this file` });
        else this.warnings.push({ file, line: `${measured}; ${SOFT}; warning only: the PR does not change this file` });
      } else if (scaled >= FILE_DURATION_WARNING_MS) {
        this.warnings.push({ file, line: `${measured}; ${WARNING}; warning only` });
      }
    }
    this.report();
  }

  report() {
    for (const { file, line } of this.failures) console.log(annotation('error', file, line));
    for (const { file, line } of this.unfinished) console.log(annotation('error', file, line, UNFINISHED));
    for (const { file, line } of this.warnings) console.log(annotation('warning', file, line));
    if (this.warnings.length) console.warn(`Vitest file duration warnings:\n${this.warnings.map(item => item.line).join('\n')}`);
    const exits = this.exits.map(({ pid, code, signal }) => `Vitest worker ${pid} exited unexpectedly: exit code ${code}, signal ${signal ?? 'none'}`);
    const sections = [
      ['Vitest file duration cap failed', this.failures.map(item => item.line)],
      [UNFINISHED, [...this.unfinished.map(item => item.line), ...exits]],
    ].filter(([, lines]) => lines.length);
    for (const [title, lines] of sections) console.error(`${title}:\n${lines.join('\n')}`);
    if (process.env.GITHUB_STEP_SUMMARY && sections.length) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, sections.map(([title, lines]) => `### ${title}\n\n${lines.map(line => `- ${line}`).join('\n')}\n`).join('\n'));
    }
    this.writeList([...this.failures, ...this.unfinished]);
  }

  // Exit code 1 and the rerun's list, for every file that failed the cap or did not finish.
  writeList(failed) {
    if (!failed.length) return;
    process.exitCode = 1;
    if (!this.list) return;
    mkdirSync(join(this.list, '..'), { recursive: true });
    writeFileSync(this.list, failed.map(item => `${item.moduleId}\n`).join(''));
  }
}
