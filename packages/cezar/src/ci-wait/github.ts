import { productEnv } from '../core/product-env.ts';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { matchesGithubPullRequest, mergedPullRequestObservations } from '../merge-observations.ts';
import { mergeProgressArgs, mergeProgressResponseSchema, mergeRequestObservation, type GithubMergeRequest } from './merge-progress.ts';
import { GITHUB_REQUEST_LIMIT, GithubRequestGate, isGithubRateLimit } from '../server/forge/github-request-gate.ts';
import { ciPrIdentitySchema, ciWaitRequestSchema, type CiPrIdentity, type CiWaitErrorCode } from '@open-mercato/cezar-contract/ci-wait';

export const CI_QUERY_TIMEOUT_MS = 10_000;
/** `gh pr checks --watch --interval`, in seconds. Not the query timeout. */
export const CI_WATCH_INTERVAL_SECONDS = 30;
export const CI_QUERY_LIMIT = GITHUB_REQUEST_LIMIT;
export const CI_OUTPUT_LIMIT = 64 * 1024;
export const CI_TERMINATE_MS = 2_000;

export class CiGithubError extends Error {
  constructor(readonly code: CiWaitErrorCode, message: string, readonly transient = false) { super(message); }
}

// The helper owns gh's process group and observes the controller-owned stdin pipe.
// EOF (including controller SIGKILL) initiates termination without trusting persisted PIDs.
// Keep this inline so the installed JS artifact carries the helper without another asset.
export const CI_PROCESS_WRAPPER = String.raw`
const { spawn } = require('node:child_process');
const command = JSON.parse(process.argv[1]);
const child = spawn(command.file, command.args, { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let stopping = false, escalation, spawnFailed = false;
function kill(force) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const args = ['/PID', String(child.pid), '/T']; if (force) args.push('/F');
    spawn('taskkill', args, {stdio:'ignore',windowsHide:true}).on('error',()=>{});
  } else { try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {} }
}
function stop() {
 if (stopping) return; stopping = true; kill(false);
 escalation = setTimeout(() => kill(true), ${CI_TERMINATE_MS});
}
process.stdin.resume(); process.stdin.on('end', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.stdout.on('error', stop); process.stderr.on('error', stop);
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.on('error', () => { spawnFailed = true; });
// A grandchild can retain the leader's stdout after exit; close alone would wait forever.
child.on('exit', () => kill(true));
child.on('close', code => { clearTimeout(escalation); process.exit(spawnFailed ? 127 : code === null ? 143 : code); });
`;
const dryRunCommand = String.raw`
const args = process.argv.slice(1);
if (args[1] === 'view') {
 const url = args[2].startsWith('https:') ? args[2] : 'https://' + args[args.indexOf('--repo')+1] + '/pull/' + args[2];
 console.log(JSON.stringify({url, number:Number(url.split('/').pop()), headRefOid:'a'.repeat(40),mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',state:'MERGED',mergedAt:'2026-01-01T00:00:00Z',mergeCommit:{oid:'b'.repeat(40)}}));
} else if (args[0] === 'api' && args[1] === 'graphql') console.log(JSON.stringify({head:'a'.repeat(40),mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',contexts:[['c',1,'Dry-run checks','CI','COMPLETED','SUCCESS','2026-01-01T00:00:00Z','',false]]}));
else if (args[0] === 'api') console.log(JSON.stringify({total_count:0,workflow_runs:[]}));
else if (!args.includes('--watch')) console.log(JSON.stringify([{name:'Dry-run checks',state:'SUCCESS',bucket:'pass',link:''}]));
`;
export type CiCommandResult = { code: number; stdout: string; stderr: string };
export type CiCommandOptions = { file: string; args: string[] };

/** Environment stays inherited, matching the existing forge gh resolver (including GH_TOKEN/GITHUB_TOKEN). */
export async function runCiCommand(command: CiCommandOptions, signal: AbortSignal, discardOutput = false, env: NodeJS.ProcessEnv = process.env, cwd?: string): Promise<CiCommandResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CI_PROCESS_WRAPPER, JSON.stringify(command)], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', bytes = 0;
    let failure: unknown;
    const abort = () => { failure ??= signal.reason; child.stdin.end(); };
    signal.addEventListener('abort', abort, { once: true });
    // Closing stdin asks the wrapper to terminate and await the owned process tree.
    const capture = (chunk: Buffer, error: boolean) => {
      if (!error && discardOutput) return;
      bytes += chunk.length;
      if (bytes > CI_OUTPUT_LIMIT) { failure ??= new CiGithubError('output_limit', 'GitHub output exceeded 64 KiB; narrow the PR check set and retry.'); child.stdin.end(); return; }
      if (error) stderr += chunk.toString(); else stdout += chunk.toString();
    };
    child.stdout.on('data', (chunk: Buffer) => capture(chunk, false));
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, true));
    child.stdin.on('error', () => {});
    child.on('error', () => { failure = new CiGithubError('gh_missing', 'Unable to launch GitHub CLI; install gh and retry.'); });
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ code: code ?? 143, stdout, stderr });
    });
    if (signal.aborted) abort();
  });
}

const metadataSchema = z.object({
  url: z.string(), number: z.number().int().positive(), headRefOid: z.string().regex(/^[0-9a-f]{40}$/i),
  mergeable: z.string().nullish().transform(value => value === 'MERGEABLE' || value === 'CONFLICTING' ? value : 'UNKNOWN' as const),
  mergeStateStatus: z.string().nullish().transform(value => (value ?? 'UNKNOWN')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 64)),
});
export type GithubPrMetadata = Pick<z.infer<typeof metadataSchema>, 'mergeable' | 'mergeStateStatus'> & { headSha: string };
// hearsay-tools/cezarion#1425: what a merge wait reads. An unknown state reads as still open.
const mergeStateSchema = z.object({
  state: z.string().nullish().transform(value => value === 'MERGED' || value === 'CLOSED' ? value : 'OPEN' as const),
  mergedAt: z.iso.datetime({ offset: true }).nullish(),
  mergeCommit: z.object({ oid: z.string().regex(/^[0-9a-f]{40}$/i) }).nullish(),
});
export type GithubPrMergeState = GithubPrMetadata & { state: 'OPEN' | 'CLOSED' | 'MERGED'; mergedAt?: string; mergeCommitSha?: string };
const METADATA_FIELDS = 'url,number,headRefOid,mergeable,mergeStateStatus';
const checkBucketSchema = z.enum(['pass', 'fail', 'pending', 'skipping', 'cancel']);
/**
 * One check of the watched commit: the newest run of its name in its workflow (hearsay-tools/squawk#3972).
 * `bucket` follows the conclusion whenever GitHub has one, so a run whose status stayed `in_progress`
 * after it concluded is settled; `stale` marks that record. `required` is GitHub's required flag for
 * this PR; a test double may leave it out.
 */
export type GithubCheck = { name: string; state: string; link: string; bucket: z.infer<typeof checkBucketSchema>;
  workflow?: string; startedAt?: string; required?: boolean; stale?: boolean };
/** One page of `checksQueryArgs`, compacted by its `--jq` program. */
const checksPageSchema = z.object({
  head: z.string().regex(/^[0-9a-f]{40}$/i),
  mergeable: metadataSchema.shape.mergeable,
  mergeStateStatus: metadataSchema.shape.mergeStateStatus,
  // [type, id, name, workflow, status, conclusion, startedAt, link, required]
  contexts: z.array(z.tuple([z.enum(['c', 's']), z.number().int().nonnegative(), z.string(), z.string(), z.string(), z.string(), z.string(), z.string(), z.boolean()])),
});
const workflowPagesSchema = z.array(z.object({
  total_count: z.number().int().nonnegative(),
  // [id, status, head matches, workflow id, conclusion, workflow name]
  workflow_runs: z.array(z.tuple([z.number().int().positive(), z.string().min(1), z.boolean(), z.number().int().nonnegative(), z.string().nullable(), z.string()])),
})).min(1);
function parseJson<T>(text: string, schema: z.ZodType<T>): T {
  try { return schema.parse(JSON.parse(text)); } catch { throw new CiGithubError('malformed_data', 'GitHub returned malformed structured data; update gh and retry.'); }
}
const rateLimitedReply = (result: CiCommandResult): boolean => result.code !== 0 && isGithubRateLimit(result.stderr);
function commandError(result: CiCommandResult): CiGithubError {
  // Only classify stderr: never forward potentially credential-bearing external diagnostics.
  if (result.code === 127) return new CiGithubError('gh_missing', 'GitHub CLI is unavailable; install gh and retry.');
  if (isGithubRateLimit(result.stderr)) return new CiGithubError('command_failed', 'GitHub query was rate limited; wait and retry.', true);
  if (/401|403|auth|log.?in|token/i.test(result.stderr)) return new CiGithubError('authentication', 'GitHub authentication failed; run gh auth login with access to this repository.');
  if (/404|not found|could not resolve|no pull requests/i.test(result.stderr)) return new CiGithubError('inaccessible_pr', 'PR is inaccessible; verify its URL and repository access.');
  return new CiGithubError('command_failed', 'GitHub query failed; check connectivity and GitHub availability, then retry.', true);
}
/** One bounded workflow query shared by CI waits and strict completion merging. */
export function activeWorkflowRunsArgs(pr: Pick<CiPrIdentity, 'repository' | 'headSha'>): string[] {
  return ['api', '--hostname', 'github.com',
      `repos/${pr.repository}/actions/runs?head_sha=${pr.headSha}&per_page=100`, '--paginate',
      '--jq', `{total_count, workflow_runs: [.workflow_runs[] | [.id, .status, (.head_sha | if type == "string" and test("^[0-9a-fA-F]{40}$") then ascii_downcase == ${JSON.stringify(pr.headSha.toLowerCase())} else null end), .workflow_id, .conclusion, .name]]} | @json`];
}

/** A workflow whose newest run on the head ended without success: no job (`startup_failure`) or `failure`. */
export type GithubRunFailure = { id: number; workflow: string; conclusion: 'startup_failure' | 'failure' };
/** The workflow runs of one head: whether any still runs, and each workflow whose newest run failed. */
export type GithubWorkflowRuns = { active: boolean; failures: GithubRunFailure[] };

export function parseWorkflowRuns(text: string): GithubWorkflowRuns {
  // Compact tuples keep 1000 ordinary runs below the output cap while retaining
  // independent head matching. --jq emits one JSON line per page; --slurp cannot be combined with --jq.
  const pages = parseJson('[' + text.trim().split(/\r?\n/).filter(Boolean).join(',') + ']', workflowPagesSchema);
  const runs = pages.flatMap(page => page.workflow_runs);
  const unique = new Set(runs.map(run => run[0]));
  if (unique.size !== runs.length || unique.size < Math.max(...pages.map(page => page.total_count))) {
    throw new CiGithubError('malformed_data', 'GitHub returned an incomplete workflow run list; retry the CI wait.');
  }
  const head = runs.filter(([, , headMatches]) => headMatches);
  // A rerun keeps its run id and a newer trigger gets a higher one: the highest id is the newest run.
  const newest = new Map<number, (typeof head)[number]>();
  for (const run of head) if ((newest.get(run[3])?.[0] ?? 0) < run[0]) newest.set(run[3], run);
  const failures = [...newest.values()].flatMap(([id, , , , conclusion, workflow]): GithubRunFailure[] =>
    conclusion === 'startup_failure' || conclusion === 'failure' ? [{ id, workflow, conclusion }] : []);
  return { active: head.some(([, status]) => status !== 'completed'), failures };
}

export function parseActiveWorkflowRuns(text: string): boolean {
  return parseWorkflowRuns(text).active;
}

const CHECKS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$sha:GitObjectID!,$endCursor:String){repository(owner:$owner,name:$repo){
pullRequest(number:$number){headRefOid mergeable mergeStateStatus}
object(oid:$sha){...on Commit{statusCheckRollup{contexts(first:100,after:$endCursor){pageInfo{hasNextPage endCursor}nodes{__typename
...on CheckRun{databaseId name status conclusion startedAt detailsUrl isRequired(pullRequestNumber:$number) checkSuite{workflowRun{workflow{name}}}}
...on StatusContext{context state targetUrl createdAt isRequired(pullRequestNumber:$number)}}}}}}}}`;
const CHECKS_JQ = '{head: .data.repository.pullRequest.headRefOid, mergeable: .data.repository.pullRequest.mergeable, '
  + 'mergeStateStatus: .data.repository.pullRequest.mergeStateStatus, contexts: [.data.repository.object.statusCheckRollup.contexts.nodes[]? | '
  + 'if .__typename == "CheckRun" then ["c", (.databaseId // 0), .name, (.checkSuite.workflowRun.workflow.name // ""), .status, (.conclusion // ""), (.startedAt // ""), (.detailsUrl // ""), (.isRequired == true)] '
  + 'else ["s", 0, .context, "", .state, "", (.createdAt // ""), (.targetUrl // ""), (.isRequired == true)] end]} | @json';
/** The PR's head and mergeability with every check of the watched commit, in one paginated query. */
export function checksQueryArgs(pr: Pick<CiPrIdentity, 'repository' | 'prNumber' | 'headSha'>): string[] {
  const [owner, repo] = pr.repository.split('/');
  // -f keeps a value a string; gh's -F would read an all-digit owner or SHA as a number.
  return ['api', 'graphql', '--hostname', 'github.com', '--paginate', '-f', `query=${CHECKS_QUERY}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`,
    '-F', `number=${pr.prNumber}`, '-f', `sha=${pr.headSha}`, '--jq', CHECKS_JQ];
}
/** gh's buckets (pkg/cmd/pr/checks/aggregate.go), applied to the conclusion when there is one. */
function bucketOf(state: string): GithubCheck['bucket'] {
  switch (state) {
    case 'SUCCESS': return 'pass';
    case 'SKIPPED': case 'NEUTRAL': return 'skipping';
    case 'ERROR': case 'FAILURE': case 'TIMED_OUT': case 'ACTION_REQUIRED': case 'STARTUP_FAILURE': return 'fail';
    case 'CANCELLED': return 'cancel';
    default: return 'pending';
  }
}
/** The PR as one checks query sees it: its head, mergeability and the newest run of each check. */
export type GithubChecksObservation = GithubPrMetadata & { checks: GithubCheck[] };
export function parseChecksObservation(text: string): GithubChecksObservation {
  const pages = parseJson('[' + text.trim().split(/\r?\n/).filter(Boolean).join(',') + ']', z.array(checksPageSchema).min(1));
  // Check run ids only grow, so the highest id is the newest run of a name, queued runs included.
  const newest = new Map<string, { row: GithubCheck; id: number }>();
  for (const [type, id, name, workflow, status, conclusion, startedAt, link, required] of pages.flatMap(page => page.contexts)) {
    const state = type === 'c' && conclusion ? conclusion : status;
    const row: GithubCheck = { name, state, link, bucket: bucketOf(state), workflow, startedAt, required,
      ...(type === 'c' && conclusion && status !== 'COMPLETED' ? { stale: true } : {}) };
    const key = JSON.stringify([type, workflow, name]);
    if ((newest.get(key)?.id ?? -1) < id) newest.set(key, { row, id });
  }
  const { head, mergeable, mergeStateStatus } = pages[0]!;
  return { headSha: head.toLowerCase(), mergeable, mergeStateStatus, checks: [...newest.values()].map(entry => entry.row) };
}

export class GithubCiClient {
  private readonly gate: GithubRequestGate;
  private readonly command: CiCommandOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd?: string | undefined;
  /** The supervisor passes the process-wide `githubRequestGate`; a client built alone gets its own. */
  constructor(options: { command?: CiCommandOptions; env?: NodeJS.ProcessEnv; cwd?: string | undefined; gate?: GithubRequestGate } = {}) {
    this.gate = options.gate ?? new GithubRequestGate();
    this.env = options.env ?? process.env;
    this.command = options.command ?? (productEnv('DRY_RUN', this.env) === '1' ? { file: process.execPath, args: ['-e', dryRunCommand] } : { file: 'gh', args: [] });
    this.cwd = options.cwd;
  }
  /**
   * One bounded gh query through the GitHub request gate, holding one of its permits. A rate-limit
   * pause is waited out before the ten-second bound starts.
   */
  private async query(args: string[], signal: AbortSignal): Promise<CiCommandResult> {
    (await this.gate.admit({ signal, permit: false }))();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(CI_QUERY_TIMEOUT_MS)]);
    try {
      return await this.gate.run(() => this.runCommand(args, bounded), { signal: bounded, permit: true, rateLimited: rateLimitedReply }); }
    catch (error) { if (!signal.aborted && bounded.aborted) throw new CiGithubError('query_timeout', 'GitHub query exceeded ten seconds; check connectivity and retry.', true); throw error; }
  }
  /** Run one gh command under a held query permit. */
  protected runCommand(args: string[], signal: AbortSignal): Promise<CiCommandResult> {
    return runCiCommand({ file: this.command.file, args: [...this.command.args, ...args] }, signal, false, this.env, this.cwd);
  }
  private async readMetadata(pr: string, signal: AbortSignal, merge = false): Promise<CiPrIdentity & GithubPrMetadata & { raw: unknown }> {
    if (!ciWaitRequestSchema.safeParse({pr}).success) throw new CiGithubError('invalid_request', 'Provide an HTTPS GitHub pull request URL.');
    const supplied = new URL(pr);
    if (supplied.hostname !== 'github.com') throw new CiGithubError('unsupported_host', 'This GitHub Enterprise host is not recognized by the forge configuration; use github.com or configure supported forge authentication.');
    const response = await this.query(['pr', 'view', pr, '--json', merge ? `${METADATA_FIELDS},state,mergedAt,mergeCommit` : METADATA_FIELDS], signal);
    if (response.code !== 0) throw commandError(response);
    const metadata = parseJson(response.stdout, metadataSchema);
    const raw: unknown = merge ? JSON.parse(response.stdout) : undefined;
    const validUrl = ciWaitRequestSchema.safeParse({pr:metadata.url});
    if (!validUrl.success) throw new CiGithubError('malformed_data', 'GitHub returned an invalid canonical PR URL.');
    const url = new URL(metadata.url);
    const parts = url.pathname.split('/');
    const suppliedParts = supplied.pathname.split('/');
    if (!matchesGithubPullRequest({ owner: suppliedParts[1]!, repo: suppliedParts[2]!, number: Number(suppliedParts[4]) }, metadata)) throw new CiGithubError('malformed_data', 'GitHub returned inconsistent PR identity.');
    return { ...ciPrIdentitySchema.parse({ prUrl: metadata.url, repository: `${parts[1]}/${parts[2]}`, prNumber: metadata.number, headSha: metadata.headRefOid }),
      mergeable: metadata.mergeable, mergeStateStatus: metadata.mergeStateStatus, raw };
  }
  async resolve(pr: string, signal: AbortSignal): Promise<CiPrIdentity> {
    const { prUrl, repository, prNumber, headSha } = await this.readMetadata(pr, signal);
    return { prUrl, repository, prNumber, headSha };
  }
  /** The PR's state for a merge wait, in one bounded query with its head and mergeability. */
  async mergeState(pr: CiPrIdentity, signal: AbortSignal): Promise<GithubPrMergeState> {
    const { headSha, mergeable, mergeStateStatus, repository, prNumber, raw } = await this.readMetadata(pr.prUrl, signal, true);
    const parsed = mergeStateSchema.safeParse(raw);
    if (!parsed.success) throw new CiGithubError('malformed_data', 'GitHub returned malformed structured data; update gh and retry.');
    const { state, mergedAt, mergeCommit } = parsed.data;
    const [owner, repo] = repository.split('/');
    if (productEnv('DRY_RUN', this.env) !== '1') mergedPullRequestObservations.observe({ owner: owner!, repo: repo!, number: prNumber }, raw);
    return { headSha, mergeable, mergeStateStatus, state, ...(mergedAt ? { mergedAt } : {}), ...(mergeCommit ? { mergeCommitSha: mergeCommit.oid.toLowerCase() } : {}) };
  }
  /** Opt-in merge supervision: current pending state and its last lifecycle event, one bounded read. */
  async mergeProgress(pr: CiPrIdentity, signal: AbortSignal): Promise<GithubPrMergeState & { mergeRequest: GithubMergeRequest }> {
    const parsedUrl = ciWaitRequestSchema.safeParse({ pr: pr.prUrl });
    if (!parsedUrl.success) throw new CiGithubError('invalid_request', 'Provide an HTTPS GitHub pull request URL.');
    if (new URL(pr.prUrl).hostname !== 'github.com') throw new CiGithubError('unsupported_host', 'Merge supervision supports github.com.');
    if (productEnv('DRY_RUN', this.env) === '1') return { ...await this.mergeState(pr, signal), mergeRequest: { isInMergeQueue: false, autoMergeEnabled: false } };
    const response = await this.query(mergeProgressArgs(pr), signal);
    if (response.code !== 0) throw commandError(response);
    const raw = parseJson(response.stdout, mergeProgressResponseSchema).data.repository.pullRequest;
    const metadata = metadataSchema.safeParse(raw);
    const merge = mergeStateSchema.safeParse(raw);
    const [owner, repo] = pr.repository.split('/');
    if (!metadata.success || !merge.success || !matchesGithubPullRequest({ owner: owner!, repo: repo!, number: pr.prNumber }, raw)) {
      throw new CiGithubError('malformed_data', 'GitHub returned inconsistent merge progress; inspect the PR and retry.');
    }
    mergedPullRequestObservations.observe({ owner: owner!, repo: repo!, number: pr.prNumber }, raw);
    return { headSha: metadata.data.headRefOid, mergeable: metadata.data.mergeable, mergeStateStatus: metadata.data.mergeStateStatus,
      state: merge.data.state, ...(merge.data.mergedAt ? { mergedAt: merge.data.mergedAt } : {}),
      ...(merge.data.mergeCommit ? { mergeCommitSha: merge.data.mergeCommit.oid.toLowerCase() } : {}), mergeRequest: mergeRequestObservation(raw) };
  }
  async workflowRuns(pr: CiPrIdentity, signal: AbortSignal): Promise<GithubWorkflowRuns> {
    const result = await this.query(activeWorkflowRunsArgs(pr), signal);
    if (result.code !== 0) throw commandError(result);
    return parseWorkflowRuns(result.stdout);
  }
  /** The PR's head and mergeability, and the checks of the watched commit, in one query. */
  async observe(pr: CiPrIdentity, signal: AbortSignal): Promise<GithubChecksObservation> {
    const result = await this.query(checksQueryArgs(pr), signal);
    if (result.code !== 0) throw commandError(result);
    return parseChecksObservation(result.stdout);
  }
  /** The long `--watch` passes the gate's pause but holds no permit: four watches must not starve every query. */
  async watch(pr: CiPrIdentity, signal: AbortSignal): Promise<void> {
    const result = await this.gate.run(() => runCiCommand({file:this.command.file,args:[...this.command.args, 'pr', 'checks', String(pr.prNumber), '--repo', `github.com/${pr.repository}`, '--watch', '--interval', String(CI_WATCH_INTERVAL_SECONDS)]}, signal, true, this.env, this.cwd),
      { signal, permit: false, rateLimited: rateLimitedReply });
    if (![0,1,8].includes(result.code) || result.stderr.trim()) throw commandError(result);
  }
}
