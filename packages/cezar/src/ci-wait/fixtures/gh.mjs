// Wire fixture: gh pr view --json url,number,headRefOid,mergeable,mergeStateStatus, gh pr checks --watch,
// the Actions runs query and the checks GraphQL query, each answered as its --jq program prints it.
// CI_FIXTURE_CHECKS (JSON) replaces the scripted check tuples: [type,id,name,workflow,status,conclusion,startedAt,link,required,event].
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ignoreTermUntilOwnerExits } from '../../stubborn-child.testkit.ts';
const args = process.argv.slice(2);
const mode = process.env.CI_FIXTURE_MODE || 'passed';
if (process.env.CI_FIXTURE_LOG) appendFileSync(process.env.CI_FIXTURE_LOG, JSON.stringify({args,pid:process.pid})+'\n');
const head = 'a'.repeat(40);
const watched = process.env.CI_FIXTURE_COUNTER && existsSync(process.env.CI_FIXTURE_COUNTER);
const conflicting = process.env.CI_FIXTURE_CONFLICT_FILE && existsSync(process.env.CI_FIXTURE_CONFLICT_FILE);
const phase = mode.startsWith('watch_') ? (watched ? mode.slice(6) : 'pending') : mode;
const rerun = process.env.CI_FIXTURE_RERUN_STATE && readFileSync(process.env.CI_FIXTURE_RERUN_STATE,'utf8');
if (mode === 'auth') { console.error('HTTP 401: authentication required secret-token'); process.exit(1); }
if (mode === 'overflow') { process.stdout.write('x'.repeat(70*1024)); process.exit(0); }
if (mode === 'malformed') { console.log('{bad'); process.exit(0); }
const mergeable = conflicting || phase === 'conflicting' ? 'CONFLICTING' : 'MERGEABLE';
if (args[0] === 'api' && args[1] === 'graphql') {
 if (process.env.CI_FIXTURE_API_ERROR) { console.error(process.env.CI_FIXTURE_API_ERROR); process.exit(1); }
 const tuple = (row, index) => { const done = row.bucket !== 'pending'; return ['c', index + 1, row.name, 'CI', done ? 'COMPLETED' : row.state === 'QUEUED' ? 'QUEUED' : 'IN_PROGRESS', done ? row.state : '', '', row.link, false, 'pull_request']; };
 const contexts = process.env.CI_FIXTURE_CHECKS ? JSON.parse(process.env.CI_FIXTURE_CHECKS) : checkRows().map(tuple);
 console.log(JSON.stringify({head: phase === 'head_changed' ? 'b'.repeat(40) : head, mergeable, mergeStateStatus: mergeable === 'CONFLICTING' ? 'DIRTY' : 'CLEAN', contexts}));
} else if (args[0] === 'api') {
 if (process.env.CI_FIXTURE_API_ERROR) { console.error(process.env.CI_FIXTURE_API_ERROR); process.exit(1); }
 const pages = rerun ? [{total_count:1,workflow_runs:[{id:1,head_sha:head,status:rerun==='complete'?'completed':rerun==='hidden'?'queued':'in_progress'}]}] : JSON.parse(process.env.CI_FIXTURE_RUN_PAGES || '[{"total_count":0,"workflow_runs":[]}]');
 for (const page of pages) console.log(JSON.stringify({...page,workflow_runs:page.workflow_runs?.map(run=>[run.id,run.status,typeof run.head_sha==='string' && /^[0-9a-f]{40}$/i.test(run.head_sha) ? run.head_sha.toLowerCase()===head : null,run.workflow_id ?? run.id,run.conclusion ?? null,run.name ?? 'CI',run.event ?? 'pull_request'])}));
} else if (args[1] === 'view') {
 console.log(JSON.stringify({url:'https://github.com/org/repo/pull/12',number:12,headRefOid: phase === 'head_changed' ? 'b'.repeat(40) : head, mergeable, mergeStateStatus: mergeable === 'CONFLICTING' ? 'DIRTY' : 'CLEAN'}));
} else if (args.includes('--watch')) {
 if(mode.startsWith('watch_')) { writeFileSync(process.env.CI_FIXTURE_COUNTER,'done'); process.exit(mode === 'watch_failed' ? 1 : 0); }
 if (mode === 'pending' || mode === 'stubborn') {
   // The test that asks for a stubborn watcher names itself the owner (hearsay-tools/squawk#3941).
   if (mode === 'stubborn') ignoreTermUntilOwnerExits(Number(process.env.CI_FIXTURE_OWNER));
   setInterval(()=>process.stdout.write('redraw\n'), 20);
 } else process.exit(mode === 'failed' ? 1 : 0);
}
function checkRows() {
 const buckets = { passed:'pass',failed:'fail',cancelled:'cancel',skipped:'skipping',pending:'pending',stubborn:'pending' };
 const rows = mode === 'no_checks' ? [] : [{name:'build',state:({pending:'PENDING',stubborn:'PENDING',failed:'FAILURE',cancelled:'CANCELLED',skipped:'SKIPPED'})[phase]||'SUCCESS',bucket:buckets[phase]||'pass',link:'https://github.com/org/repo/actions/runs/1'}];
 if (rerun && rerun !== 'hidden') rows.push({name:'review rerun',state:rerun==='complete'?'SUCCESS':'PENDING',bucket:rerun==='complete'?'pass':'pending',link:'https://github.com/org/repo/actions/runs/1/job/2'});
 if (phase.startsWith('mixed_')) {
  rows.push({name:'optional publish',state:'SKIPPED',bucket:'skipping',link:''});
  const result = phase.slice(6);
  rows[0].bucket = buckets[result];
  rows[0].state = {passed:'SUCCESS',failed:'FAILURE',cancelled:'CANCELLED',skipped:'SKIPPED'}[result];
 }
 if (mode === 'many') for(let i=0;i<150;i++) rows.push({name:'x'.repeat(250)+i,state:i===149?'FAILURE':'SUCCESS',bucket:i===149?'fail':'pass',link:''});
 return rows;
}
