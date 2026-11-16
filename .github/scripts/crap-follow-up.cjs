'use strict';

// After a pull request merges into main, files each changed function whose CRAP is over the limit
// as one line in the open `crap-follow-up` issue (hearsay-tools/squawk#3702). The scores come from
// the `crap-report-<head SHA>` artifact of the pull request's last CI run, which the `crap-report`
// job wrote from that run's Vitest coverage. See docs/sdlc/ci.md § CRAP report for changed functions.
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { parseArgs } = require('node:util');

const LABEL = 'crap-follow-up';
const MARKER = '<!-- crap-follow-up:v1 -->';
const TITLE = 'Changed functions over CRAP 30';
const KEY = /<!-- crap:(.+?) -->\s*$/;

const percent = (share) => `${Math.round(share * 100)}%`;
const keyOf = (fn) => `${fn.file}#${fn.name}`;

/** The checklist line for one function over the limit, keyed by file and function name. */
function findingLine(fn, pr) {
  return `- [ ] \`${fn.file}:${fn.line}\` \`${fn.name}\`: CRAP ${fn.crap.toFixed(1)} (complexity ${fn.complexity}, coverage ${percent(fn.coverage)}), from ${pr} <!-- crap:${keyOf(fn)} -->`;
}

function header(limit) {
  return [
    MARKER,
    `Changed functions that merged with a CRAP score over ${limit}. CI's \`Report CRAP for changed functions\` job scores them from the pull request's Vitest coverage (docs/sdlc/ci.md § CRAP report for changed functions).`,
    '',
    `Bring a function to CRAP ${limit} or less with tests or a split, then tick its line. A later merge that changes a listed function replaces its line.`,
    '',
  ].join('\n');
}

/**
 * The issue body with one line per finding: a function already listed gets its line replaced in
 * place, a new one is appended. Every other line is kept as it is.
 */
function mergeBody(body, findings, { pr, limit }) {
  const lines = (body && body.includes(MARKER) ? body : header(limit)).replace(/\n+$/, '').split('\n');
  const index = new Map();
  lines.forEach((line, at) => {
    const match = KEY.exec(line);
    if (match) index.set(match[1], at);
  });
  let added = 0, updated = 0;
  for (const fn of findings) {
    const line = findingLine(fn, pr);
    const at = index.get(keyOf(fn));
    if (at === undefined) { index.set(keyOf(fn), lines.push(line) - 1); added++; } else { lines[at] = line; updated++; }
  }
  return { body: `${lines.join('\n')}\n`, added, updated };
}

const overLimit = (report) => (report.functions ?? []).filter((fn) => fn.status === 'over');

function cli(run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })) {
  const gh = (...args) => run('gh', args);
  const api = (path) => JSON.parse(gh('api', path));
  return { gh, api };
}

/** The merged pull request: by number, or the one whose merge commit is `commit`. */
function resolvePullRequest({ api }, repo, { pr, commit }) {
  if (pr) {
    const pull = api(`repos/${repo}/pulls/${pr}`);
    return pull.merged_at ? pull : undefined;
  }
  return api(`repos/${repo}/commits/${commit}/pulls`).find((pull) => pull.merged_at && pull.merge_commit_sha === commit);
}

/** The newest CI run on the pull request's head that kept a `crap-report-<head>` artifact, with that report. */
function downloadReport({ gh, api }, repo, head) {
  const name = `crap-report-${head}`;
  const runs = api(`repos/${repo}/actions/runs?head_sha=${head}&event=pull_request_target&per_page=30`).workflow_runs ?? [];
  const ci = runs.filter((run) => run.path === '.github/workflows/ci.yml').sort((a, b) => b.id - a.id);
  for (const run of ci) {
    const artifacts = api(`repos/${repo}/actions/runs/${run.id}/artifacts?name=${name}`).artifacts ?? [];
    if (!artifacts.some((artifact) => !artifact.expired)) continue;
    const dir = mkdtempSync(join(tmpdir(), 'crap-report-'));
    try {
      gh('run', 'download', String(run.id), '-R', repo, '-n', name, '-D', dir);
      return { run: run.id, report: JSON.parse(readFileSync(join(dir, 'crap-report.json'), 'utf8')) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return undefined;
}

function openIssue({ gh }, repo) {
  const issues = JSON.parse(gh('issue', 'list', '-R', repo, '--label', LABEL, '--state', 'open', '--json', 'number,body', '--limit', '20'));
  return issues.filter((issue) => issue.body.includes(MARKER)).sort((a, b) => a.number - b.number)[0];
}

function writeIssue({ gh }, repo, issue, body) {
  const dir = mkdtempSync(join(tmpdir(), 'crap-follow-up-'));
  const file = join(dir, 'body.md');
  try {
    writeFileSync(file, body);
    if (issue) {
      gh('issue', 'edit', String(issue.number), '-R', repo, '--body-file', file);
      return issue.number;
    }
    gh('label', 'create', LABEL, '-R', repo, '--color', 'FBCA04', '--description', 'Changed functions that merged over CRAP 30', '--force');
    const url = gh('issue', 'create', '-R', repo, '--title', TITLE, '--label', LABEL, '--body-file', file).trim();
    return Number(url.split('/').pop());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Files the findings of the merged pull request; returns the lines for the job summary. */
function followUp(io, { repo, pr, commit, dryRun }) {
  const pull = resolvePullRequest(io, repo, { pr, commit });
  if (!pull) return [`No merged pull request for ${pr ? `#${pr}` : commit} in ${repo}; nothing to file.`];
  const ref = `${repo}#${pull.number}`;
  const found = downloadReport(io, repo, pull.head.sha);
  if (!found) return [`No \`crap-report-${pull.head.sha}\` artifact for ${ref}: its last CI run wrote no CRAP report (no Vitest coverage, or the report job failed). Nothing to file.`];
  const findings = overLimit(found.report);
  const lines = [`CRAP report of ${ref} from CI run ${found.run}: ${found.report.functions.length} changed functions, ${findings.length} over ${found.report.limit}.`];
  if (!findings.length) return lines;
  const issue = openIssue(io, repo);
  const merged = mergeBody(issue?.body, findings, { pr: ref, limit: found.report.limit });
  if (dryRun) return [...lines, `Dry run: would ${issue ? `edit #${issue.number}` : 'create the issue'} (${merged.added} added, ${merged.updated} updated). Body:`, '', '```markdown', merged.body, '```'];
  const number = writeIssue(io, repo, issue, merged.body);
  return [...lines, `${issue ? 'Updated' : 'Opened'} ${repo}#${number}: ${merged.added} added, ${merged.updated} updated.`];
}

function main(argv, { env = process.env, io = cli(), stdout = process.stdout } = {}) {
  const { values } = parseArgs({ args: argv, options: {
    repo: { type: 'string' }, pr: { type: 'string' }, commit: { type: 'string' }, 'dry-run': { type: 'boolean' },
  } });
  if (!values.repo || (!values.pr === !values.commit)) throw new Error('Usage: crap-follow-up.cjs --repo <owner/name> (--pr <number> | --commit <sha>) [--dry-run]');
  const lines = followUp(io, { repo: values.repo, pr: values.pr, commit: values.commit, dryRun: Boolean(values['dry-run']) });
  const text = `${lines.join('\n')}\n`;
  stdout.write(text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`crap-follow-up: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { LABEL, MARKER, findingLine, mergeBody, followUp, main };
