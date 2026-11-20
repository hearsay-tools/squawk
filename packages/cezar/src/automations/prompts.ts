/**
 * Short task instructions and the full automation playbook, composed only for reachable
 * automations. Use the current absolute CLI command; do not substitute another automation
 * mechanism.
 */
import { fileURLToPath } from 'node:url';
import { BUILT_IN_RUNNERS } from '../runners/built-in.ts';


const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** This process's own `automation` command, shell-quoted — the same construction as `artifact publish`. */
export function automationCliCommand(): string {
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(source ? '../index.ts' : '../index.js', import.meta.url));
  return [process.execPath, ...(source ? ['--import', import.meta.resolve('tsx')] : []), entry].map(quote).join(' ') + ' automation';
}

/**
 * The definition reference, as `cez automation schema` prints it and as the skill body embeds it.
 * One string so the two never disagree; `prompts.test.ts` pins it to the storage schema.
 */
export const AUTOMATION_SCHEMA_REFERENCE = `An automation definition is one JSON object. Two kinds: a GitHub poll ("kind": "github") or a schedule ("kind": "schedule"). The three examples below are valid definitions as written; the keys they use are explained after them.

A GitHub poll:

{
  "name": "Review every new pull request",
  "description": "What this automation is for",
  "kind": "github",
  "events": ["pull_request.opened"],
  "intervalSeconds": 300,
  "filters": { "excludeLabels": ["wontfix"], "lookbackDays": 7, "maxRecords": 25 },
  "task": {
    "prompt": "Review pull request #{{github.number}} ({{github.title}}) at {{github.url}}: read the diff, run the tests, and post your findings as a review.",
    "workflow": "quick-task",
    "worktree": true,
    "autonomous": true
  }
}

A schedule:

{
  "name": "Nightly dependency bump",
  "kind": "schedule",
  "schedule": { "type": "daily", "hour": 4, "minute": 0 },
  "task": { "prompt": "Run npm outdated, bump patch and minor versions, run the tests, open a draft PR if anything changed. Today is {{date}}." }
}

A one-time schedule (replace "at" with a future time):

{
  "name": "Check the rollout next week",
  "kind": "schedule",
  "schedule": { "type": "once", "at": "2030-01-15T09:00", "timeZone": "Europe/Warsaw", "latestStartMinutes": 360 },
  "task": { "prompt": "Check the error rate of the release deployed last week, compare it with the week before, and report what changed." }
}

Top-level keys:
- "name": required, 1-200 characters.
- "description": optional, up to 2000 characters.
- "kind": "github" (the default when omitted) or "schedule".
- "events" (GitHub poll, required): 1-4 of pull_request.opened, issue.opened, issue.labeled, issue.unlabeled.
- "intervalSeconds" (GitHub poll): how often GitHub is polled, 60-86400 seconds; default 300.
- "filters" (GitHub poll): may be {}; every key is optional, and a candidate must pass ALL the given filters.
- "schedule" (schedule, required): "type" is "daily" or "weekdays" (Mon-Fri) at "hour" and "minute"; "weekly" adds "day" (1 = Monday ... 7 = Sunday); "hours" uses "every" (1 | 2 | 3 | 4 | 6 | 8 | 12) from 00:00. These repeating shapes run in the cockpit's own time zone. "once" runs a single time: "at" is the local wall time "YYYY-MM-DDTHH:MM" in "timeZone" (an IANA name such as Europe/Warsaw, required), and the optional "latestStartMinutes" (10-43200) is how late after "at" a start may still launch when Squawk was not running; without it a late start always launches. Once its task exists, a one-time schedule is archived with the task's id ("archived": { "outcome": "launched", "runId": ... }) and never fires again. "run <id>" (Run now) consumes it the same way. "cancel <id>" archives it without a task ("outcome": "cancelled"). An archived schedule cannot change; "list --archived only" shows them. "at" must be in the future when it is created, moved or enabled.
- "task": the ordinary task each match or occurrence launches.

"filters" keys:
- "includeExisting": boolean (default false). When true, include matching events before enablement within lookbackDays. Turning this on for an enabled poll reopens the window on its next check; durable receipts prevent duplicate launches.
- "requireCurrentLabels": boolean (default false). Opt in to rechecking label filters against the live issue before receipt reservation and task creation; obsolete transitions do not claim a task. Historical event matching is unchanged when omitted.
- "authors": GitHub logins that opened it. "assignees": current assignees.
- "allLabels": must carry every one of these labels. "anyLabels": must carry at least one. "excludeLabels": must carry none.
- "changedLabels": REQUIRED for issue.labeled and issue.unlabeled: the label whose change fires it.
- "lookbackDays": 1-90 (default 7), how far back one poll looks. "maxRecords": 1-100 (default 25), the most candidates one poll considers.

"task" keys:
- "prompt": required, the prompt template.
- "workflow": a workflow name. OR "steps", never both. To run a skill, use one agent step naming it: "steps": [{ "id": "task", "skill": "some-skill", "prompt": "{{task}}" }].
- "runner": ${BUILT_IN_RUNNERS.map(({ id }) => id).join(' | ')}. "model" and "effort": optional overrides.
- "worktree": isolate each run in its own git worktree (recommended: true).
- "autonomous": never park to ask; an automation has no one watching (recommended: true).
- "archiveWhenDone": boolean (default false). Archive each launched task after Done. Without a PR, archive on Done even when autoMergePr is true.
- "autoMergePr": boolean (default false). After Done, merge the task's PR only when current-head CI and GitHub rules pass. This may mark a draft ready. With archiveWhenDone, merge before archive. Pending or blocked actions show a reason on the task. These settings apply to future tasks; editing the automation does not change tasks it already launched.
- "allowWorkers": boolean (default true). Agents in each launched task may start and resume Squawk workers, each a separate paid agent session.
- "allowMessaging": boolean (default true). Agents in each launched task may message other tasks in this project.
- "systemPrompt": extra guidance for every launched run.

For a GitHub poll, name, events and task are required; for a schedule, name, kind, schedule and task.

Prompt placeholders, substituted per launch. GitHub poll: {{github.kind}} (issue | pull request), {{github.number}}, {{github.title}}, {{github.url}}, {{github.author}}, {{github.assignees}}, {{github.labels}} and {{github.event}}. Schedule: {{date}}, {{time}}, {{project}} and {{automation}}. Any other placeholder is rejected. The matched item's details (or the scheduled instant) are also appended to every launched task as untrusted context, so the prompt need not repeat them.

A new automation is PAUSED unless created with --enable. Enabling a GitHub poll establishes a current-time baseline by default; filters.includeExisting opts in to older matches within the configured lookback. Test filter previews the selected window without advancing the execution cursor or launching tasks. Enabling a schedule arms its next occurrence.`;

/** The part composed into every task's system prompt while automations are on and reachable. */
export function automationsPrompt(command: string): string {
  return `## Automations
This cockpit can do recurring work without you doing it once. An automation is either a bounded GitHub poll (a new pull request, a new issue, a label added to or removed from an issue, optionally filtered by author, assignee or labels) or a schedule (every day at a time, weekdays, one weekday a week, every N hours). It launches an ordinary task for every match or occurrence, from a prompt template you write. When the user asks for something to happen "whenever", "every time" or "each time" a pull request or issue appears or is labelled, or "every day at", "on weekdays", "every Friday", "every 6 hours", they are asking for an automation: create one instead of doing the work once, and instead of polling GitHub or sleeping yourself.

Use cezar_automation to create, preview and enable repeating automations. Read its input schema and run ${command} schema first for the definition shape, bounds and prompt placeholders. Each call returns one JSON answer:

- action "create", definition: the GitHub poll or repeating schedule to create. It is always PAUSED.
- action "show", id: read the definition and its cockpit url.
- action "preview", id: preview a GitHub poll now without launching tasks or advancing its execution cursor. Preview the selected history window; enabling excludes older events by default. Set filters.includeExisting only when the user asks to include older matches within the configured lookback; receipts still prevent duplicate launches.
- action "enable", id, explicit: true: enable only when the user's own request explicitly asks for it to be switched on. A GitHub poll needs a successful preview of its current definition in this session first. Preview again after any edit.

When work must start much later (tomorrow, next week) as a new task, use cezar_schedule_task (at in UTC or delay) instead of keeping this session waiting on repeated timers; enable it only when the user asked for the work to run later. Use cezar_scheduled_tasks to list, show, update, pause, enable or cancel a one-time schedule.

Completion controls are off by default. Use task.archiveWhenDone only when the user asks to archive completed tasks. Use task.autoMergePr only when the user asks to merge their PRs. Both act after Done; auto merge may mark a draft ready and still requires current-head CI and GitHub rules. With both on, merge before archive; without a PR, archive on Done. Changes affect future tasks only.

Create the automation PAUSED. A paused automation is the finished state of this task, not a step awaiting confirmation: enable it only when the user's own request explicitly asks for it to be switched on. An instruction to continue autonomously, not to ask for confirmation, or to make reasonable assumptions is not that request. For a GitHub poll, run a preview check so the user sees what it would match; for a schedule, report its next occurrence (next_run_at is UTC; convert to the user's time zone and name it). Put the "url" the tool returns in your final message. Name the automation, its id, whether it is paused or enabled, its preview matches or next occurrence, and the exact prompt template it will launch. If a call fails or is refused, stop and report that automations are unavailable on this cockpit, quoting its error: do not write a cron job, a GitHub Action or a polling script as a substitute.

Use the CLI for the other automation operations. Every command prints one JSON object:

  ${command} schema                                   the definition shape, every key, every bound, the prompt placeholders
  ${command} list | show <id>                          list definitions or show one
  ${command} update <id> --file <def.json>              update replaces each key given; "task" merges key by key, null removes one
  ${command} pause <id> | delete <id>                  pause or delete a definition
  ${command} run <id>                                 launch a schedule once, now, when the user asks
  ${command} check <id> --execute                      execute a GitHub poll now, when the user asks

Create, preview and enable repeating automations through cezar_automation, so paused creation and preview-before-enable are enforced. Use the CLI schema on demand; keep definition files outside the repository.`;
}
