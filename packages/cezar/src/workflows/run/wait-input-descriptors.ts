import { builtInSquawkWaitRequestSchema } from '@open-mercato/cezar-contract/wait-tools';
import { z } from 'zod';
import type { WaitInputDescriptor } from './wait-kind-registry.ts';
import { cliCommandAdvertised } from '../../core/cli-registry.ts';

/** The process-wait fields name `hsq job` only while that command can run here; without the jobs
 *  feature they name only the agent's own exit file (spec 2026-11-26-launch-slot-and-bundled-jobs). */
const jobs = () => cliCommandAdvertised('job');

const descriptions: Record<string, string> = {
  operation_id: 'Optional retry identity. Reuse it with exactly the same arguments after an unknown outcome; never use it for a different registration.',
  pr: 'kind "pr": the HTTPS GitHub pull request URL.',
  until: 'kind "pr": "checks" (default) watches checks; "merge" waits for merge or closure and ignores queue removal. After requesting a merge, use "merge_or_blocked": wakes on merge, closure, conflict, or neither queue membership nor enabled auto-merge remaining. Pending checks or a queue slot alone do not end it. All targets retain their deadline and query-error exits. Only "merged" confirms success; "blocked" requires inspection and grants no permission to retry or merge.',
  wake_on_conflict: 'kind "pr": Default true for "checks" and "merge". Set false when your work depends on another PR merging and you want to ignore its conflicts. "merge_or_blocked" always reports conflicts, regardless of this setting. With "checks", a conflicting PR may have no checks, ending as no_checks or deadline.',
  head_sha: 'kind "pr": optional. Right after you push, pass the pushed commit (`git rev-parse HEAD`): the wait watches it while GitHub still shows the previous head, for up to 60 seconds.',
  worker_ids: 'kind "worker": the workers you own to wait for (1–32 unique ids).',
  request_ids: 'kind "request": the requests you sent, to a worker, your parent or a peer task, to wait for a reply to (1–32 unique ids).',
  peer_ids: 'kind "peer": the peer root tasks of this project to wait for (1–32 unique task ids; find them with `hsq message tasks`). A message from one of them, or one of them settling, ends the wait; other messages wake you and keep it open.',
  mode: 'kind "worker" or "request": "any" wakes you when one selected id settles (default), "all" when every one has, "one" takes exactly one id.',
  timeout_seconds: 'The deadline in seconds. kind "pr": 1–7200, default 1800. kind "worker", "request" or "peer": 1–7200, default 600 (the default shown is the pr one). kind "process": 1–7200, default 1800.',
  seconds: 'kind "timer": seconds until the wake (60–7200).',
  get pid() {
    return jobs() ? 'kind "process": the PID of the background command: the `pid` the job start command printed.'
      : 'kind "process": the PID of the background command.';
  },
  get exit_file() {
    return `kind "process": optional. ${jobs() ? 'The `exitFile` that `hsq job start` printed for this `pid`, in any `--dir`, or a' : 'A'} file that your own wrapper writes the exit code to, in $TMPDIR or the worktree, with a new name for each command. Leave it out for a command that is already running or that writes its status file somewhere else.`;
  },
  note: 'kind "timer" or "process": what to re-check, handed back to you at the wake.',
};
const kindDescriptions = '"pr" waits for a GitHub pull request: its checks or its merge (see `until`); "worker" waits for workers you own; "request" waits for replies to requests you sent; "peer" waits for named peer tasks to message you or settle; "timer" wakes you after `seconds`; "process" wakes you when a background command ends.'.split('; ');

/** Built-in request order and shared-field precedence stay identical to the shipped schema. */
export function builtInWaitInputs(kind: string): WaitInputDescriptor[] {
  return builtInSquawkWaitRequestSchema.options.flatMap((schema, order) => {
    const requestKind = schema.shape.kind.value;
    if (requestKind !== kind && !({ worker: ['request'] } as Record<string, string[]>)[kind]?.includes(requestKind)) return [];
    const properties = z.toJSONSchema(schema, { io: 'input' }).properties ?? {};
    return [{ kind: requestKind, order, inputSchema: schema, properties, descriptions, description: kindDescriptions[order]! }];
  });
}
