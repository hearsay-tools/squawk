import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GithubCiClient } from './github.ts';

const fixture = fileURLToPath(new URL('./fixtures/gh.mjs', import.meta.url));
const identity = {prUrl:'https://github.com/org/repo/pull/12',repository:'org/repo',prNumber:12,headSha:'a'.repeat(40)};
const signal = () => new AbortController().signal;
const run = (id: number, status = 'completed', head_sha = identity.headSha) => ({id,status,head_sha});
function client(pages: unknown, env: Record<string,string> = {}) {
 return new GithubCiClient({command:{file:process.execPath,args:[fixture]},env:{...process.env,CI_FIXTURE_RUN_PAGES:JSON.stringify(pages),...env}});
}
const dirs: string[] = [];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});

it.each(['queued','in_progress','waiting','requested','pending','future_status'])('keeps %s workflow runs pending even on later pages',async status=>{
 const pages=[{total_count:2,workflow_runs:[run(1)]},{total_count:2,workflow_runs:[run(2,status)]}];
 expect(await client(pages).workflowRuns(identity,signal())).toMatchObject({active:true});
});
it('allows completed workflows and ignores a different head',async()=>{
 expect(await client([{total_count:2,workflow_runs:[run(1),run(2,'in_progress','b'.repeat(40))]}]).workflowRuns(identity,signal())).toMatchObject({active:false});
 expect(await client([{total_count:0,workflow_runs:[]}]).workflowRuns(identity,signal())).toMatchObject({active:false});
});
it.each([
 [], [{total_count:2,workflow_runs:[run(1)]}],
 [{total_count:2,workflow_runs:[run(1)]},{total_count:2,workflow_runs:[run(1)]}],
 [{total_count:1,workflow_runs:[{id:1,head_sha:identity.headSha}]}],
 [{total_count:1,workflow_runs:[run(1,'')]}],
 [{total_count:1,workflow_runs:[run(1,'in_progress','invalid')]}],
].map(pages=>({pages})))('rejects incomplete or malformed workflow data instead of allowing success: $pages',async ({pages})=>{
 await expect(client(pages).workflowRuns(identity,signal())).rejects.toMatchObject({code:'malformed_data'});
});
it.each(['auth','malformed','overflow'])('fails closed on workflow query %s',async mode=>{
 await expect(client([],{CI_FIXTURE_MODE:mode}).workflowRuns(identity,signal())).rejects.toMatchObject({code:{auth:'authentication',malformed:'malformed_data',overflow:'output_limit'}[mode]});
});
it('queries the captured head with bounded paginated structured output',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ci-runs-'));dirs.push(dir);const log=join(dir,'calls');
 await client([{total_count:0,workflow_runs:[]}],{CI_FIXTURE_LOG:log}).workflowRuns(identity,signal());
 const {args}=JSON.parse((await readFile(log,'utf8')).trim()) as {args:string[]};
 expect(args).toEqual(['api','--hostname','github.com','repos/org/repo/actions/runs?head_sha='+identity.headSha+'&per_page=100','--paginate','--jq','{total_count, workflow_runs: [.workflow_runs[] | [.id, .status, (.head_sha | if type == "string" and test("^[0-9a-fA-F]{40}$") then ascii_downcase == '+JSON.stringify(identity.headSha)+' else null end), .workflow_id, .conclusion, .name]]} | @json']);
});
it('supports workflow queries in the bundled dry-run command',async()=>{
 expect(await new GithubCiClient({env:{...process.env,CEZ_DRY_RUN:'1'}}).workflowRuns(identity,signal())).toMatchObject({active:false});
});

it.each([
 ['HTTP 403: API rate limit exceeded for user', 'command_failed', true],
 ['HTTP 403: You have exceeded a secondary rate limit. Please wait before you try again.', 'command_failed', true],
 ['HTTP 429: Too many requests', 'command_failed', true],
 ['unexpected gateway reply private-value', 'command_failed', true],
 ['HTTP 403: Resource not accessible by integration', 'authentication', false],
 ['HTTP 401: Bad credentials', 'authentication', false],
])('classifies workflow query error %s without exposing diagnostics',async (stderr,code,transient)=>{
 await expect(client([],{CI_FIXTURE_API_ERROR:stderr as string}).workflowRuns(identity,signal())).rejects.toMatchObject({code,transient});
});

it('observes a complete 1000-run Actions history within the existing output cap',async()=>{
 const pages=Array.from({length:10},(_,page)=>({total_count:1000,workflow_runs:Array.from({length:100},(_,index)=>run(page*100+index+1))}));
 expect(await client(pages).workflowRuns(identity,signal())).toMatchObject({active:false});
 pages[9]!.workflow_runs[99]!.status='in_progress';
 expect(await client(pages).workflowRuns(identity,signal())).toMatchObject({active:true});
});

const failed = (id: number, workflow_id: number, conclusion: string | null, name = 'CI') => ({...run(id),workflow_id,conclusion,name});
it('reports each workflow whose newest run on the head created no job or failed',async()=>{
 const pages=[{total_count:4,workflow_runs:[failed(1,7,'startup_failure'),failed(2,8,'failure','Lint'),failed(3,9,'cancelled','Review signal'),failed(4,10,'success','Docs')]}];
 expect(await client(pages).workflowRuns(identity,signal())).toEqual({active:false,failures:[{id:1,workflow:'CI',conclusion:'startup_failure'},{id:2,workflow:'Lint',conclusion:'failure'}]});
});
it('judges a workflow by its newest run on the head only',async()=>{
 // hearsay-tools/squawk#3738: CI ended startup_failure, and a later run of the same workflow passed.
 const pages=[{total_count:3,workflow_runs:[failed(43906943124,7,'startup_failure'),failed(43926799976,7,'success'),{...failed(5,7,'failure'),head_sha:'b'.repeat(40)}]}];
 expect(await client(pages).workflowRuns(identity,signal())).toEqual({active:false,failures:[]});
});
