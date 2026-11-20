// A separate native gh wire: identity and mergeability are external JSON, never normalized events.
import { existsSync, appendFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
const [gate, log, ...args] = process.argv.slice(2);
appendFileSync(log, JSON.stringify(args) + '\n');
const mergeable = () => existsSync(gate + '.clean') ? 'MERGEABLE' : 'CONFLICTING';
const mergeStateStatus = () => existsSync(gate + '.clean') ? 'CLEAN' : 'DIRTY';
if (args[1] === 'view') {
  console.log(JSON.stringify({ url: 'https://github.com/acme/repo/pull/12', number: 12,
    headRefOid: 'a'.repeat(40), mergeable: mergeable(), mergeStateStatus: mergeStateStatus() }));
} else if (args[0] === 'api' && args[1] === 'graphql') {
  // The checks query answers only once the test opens the gate.
  while (!existsSync(gate)) await setTimeout(5);
  console.log(JSON.stringify({ head: 'a'.repeat(40), mergeable: mergeable(), mergeStateStatus: mergeStateStatus(),
    contexts: [['c', 1, 'build', 'CI', 'COMPLETED', 'SUCCESS', '', '', false, 'pull_request']] }));
} else if (args[0] === 'api') {
  console.log(JSON.stringify({ total_count: 0, workflow_runs: [] }));
}
