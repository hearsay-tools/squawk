import { parseArgs } from 'node:util';
import { commandText } from '../home/command.ts';
import { JobError, SUPERVISE, jobDirectory, jobStatus, startJob, stopJob, superviseJob, tellAnswerFile, tellStarter } from './job.ts';

const HELP = commandText(`Usage: cez job start <name> [--dir <dir>] -- <command> [args...]
       cez job status <name> [--dir <dir>]
       cez job stop <name> [--dir <dir>]

start   Run a long command so that it outlives this shell call, the turn and the
        agent session. Writes its output to a log file and its exit code to an
        exit file in <dir>; each start has files of its own. Prints JSON with
        the long-lived "pid", "log" and "exitFile": pass "pid" and "exitFile"
        to a process wait. Exits 1 and names the running PID while a job of
        that name still runs. A name whose job ended starts again.
status  Print JSON: "state" is "running" or "exited", with "pid", "log",
        "exitFile", and "exitCode" when the exit file holds one.
stop    End the job's whole process group: SIGTERM, then SIGKILL after 10 s for
        what still runs. Stop a job with this, never with kill <pid>: that
        reaches only the command, and its children can keep running. On Linux
        it also ends what such a kill left behind; elsewhere nothing proves
        that group is still the job's, so it is reported, not signalled.
        Prints JSON with "stopped"; it is false, with exit 1, while a process
        of the job may still run.

--dir <dir>  Where the job's files live. Default: $TMPDIR, the task's temp
             directory. Squawk keeps it across its own restart while the
             task is live. A job that still runs when the task ends keeps it, so
             the log and exit code outlive the task. Squawk removes it at the
             task's next end, its archive or Squawk's next start, once no job
             in it runs, and at once when the task's history is deleted. For
             files that must outlive the task, or a $TMPDIR under the system
             temp directory, which a reboot can clear, pass a directory you
             keep. A process wait accepts the exit file in any --dir.
-h, --help   Show this help.

The command runs without a shell. For a pipeline, pass: -- sh -c '<pipeline>'.`);

/** The verbs `cez job` accepts. */
export const JOB_ACTIONS = ['start', 'status', 'stop'] as const;
const ACTIONS = new Set<string>(JOB_ACTIONS);

/** `cez job`: one JSON object on stdout for a result and on stderr for an error; help is text. */
export async function runJobCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (argv[0] === SUPERVISE) {
    if (argv[3] === '--answer-file' && argv[4]) {
      return superviseJob(argv[1]!, argv[2]!, argv.slice(6), answer => tellAnswerFile(argv[4]!, answer));
    }
    return superviseJob(argv[1]!, argv[2]!, argv.slice(4), tellStarter);
  }
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  if (own.includes('--help') || own.includes('-h')) { console.log(HELP); return 0; }
  try {
    const { values, positionals } = parseArgs({ args: own, options: { dir: { type: 'string' } }, allowPositionals: true });
    const [action, name, ...rest] = positionals;
    if (!name || rest.length > 0 || !ACTIONS.has(action!)) throw new JobError(HELP);
    const dir = jobDirectory(values.dir, env);
    if (action !== 'start' && command.length > 0) throw new JobError(HELP);
    if (action === 'status') { console.log(JSON.stringify(jobStatus(dir, name))); return 0; }
    if (action === 'stop') {
      const stopped = await stopJob(dir, name);
      console.log(JSON.stringify(stopped));
      return stopped.stopped ? 0 : 1;
    }
    console.log(JSON.stringify(await startJob({ name, dir, command, env })));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'The job command failed' }));
    return 1;
  }
}
