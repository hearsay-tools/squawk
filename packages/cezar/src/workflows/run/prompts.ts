import type { RunRecord } from '../../runs/store.ts';
import { productName } from '../../home/display.ts';

/**
 * The effective "extra" system prompt for a run (spec §protocol v2, R2 2.3):
 * the per-run override (`POST /api/runs` `systemPrompt`) REPLACES the
 * `config.json` default — they are the same knob at two scopes, so the more
 * specific one wins outright; they never concatenate. Whichever wins is
 * ADDITIVE to the skill body and the handoff contract, which always ride
 * along (see `composeSystemPrompt`). Blank strings count as unset.
 */
export function resolveExtraSystemPrompt(
  override: string | undefined,
  configDefault: string | undefined,
): string | undefined {
  return override?.trim() || configDefault?.trim() || undefined;
}

/**
 * Joins the parts of one agent step's system prompt in fixed order — skill
 * body (most task-specific), then the run's extra prompt (user guidance, can
 * amend the skill), then the handoff contract (always last, never optional in
 * practice). Blank parts drop out; survivors join with the same `\n\n---\n\n`
 * divider the skill+handoff composition has always used.
 */
export function composeSystemPrompt(...parts: Array<string | undefined>): string {
  return parts
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p))
    .join('\n\n---\n\n');
}

/**
 * The directories a spawned agent may reach outside its worktree: the run-state
 * folder that holds its handoff file, plus its own temp directory when this run
 * got one (#785). Handing an agent a `TMPDIR` its file tools are not allowed to
 * write would trade one silent failure for another, so the two travel together;
 * under `CEZ_AGENT_TMPDIR=0` there is no per-run directory and the list is
 * exactly what it always was.
 */
export function agentDirectories(runsDir: string, env: Record<string, string>): string[] {
  return env.TMPDIR ? [runsDir, env.TMPDIR] : [runsDir];
}

/** The notice a Continue's checkpoint adds in front of its prompt, or undefined. The cockpit shows
 *  the same text as a note beside the Continue's message (hearsay-tools/squawk#3882). */
export function resumeNotice(message: RunRecord['continuationMessage']): string | undefined {
  const context = message?.resumeContext;
  if (!context?.failure && !context?.restarted) return undefined;
  const parts: string[] = [];
  if (context.restarted) parts.push(`The ${productName('Cezar')} process restarted while you were working on this task. Read the handoff file (HSQ_HANDOFF_FILE (CEZ_HANDOFF_FILE fallback)) to recover context.`);
  if (context.failure) {
    const { stepId, error } = context.failure;
    // Error messages can contain newlines; keep the diagnostic on one line without changing
    // the saved error, or the human text that follows it.
    parts.push(`The previous ${stepId ? `step ${JSON.stringify(stepId)}` : 'turn'} failed: ${error.replace(/[\r\n\u2028\u2029]+/g, ' ')}`);
  }
  parts.push('The previous agent process stopped. Background work it started, such as subagents and shell commands, stopped with it. Check its state before you wait on it or restart it.');
  return parts.join(' ');
}

/** Compose only at delivery. The durable continuation retains its original text/attachments. */
export function withResumeContext(prompt: string, message: RunRecord['continuationMessage']): string {
  const notice = resumeNotice(message);
  return notice ? `${notice}\n${prompt}` : prompt;
}

export function applyTemplate(template: string, task: string): string {
  return template.replaceAll('{{task}}', () => task);
}

/** The `name` of a prompt's leading `/name` slash command, else undefined. */
export function leadingSlashSkillName(text: string): string | undefined {
  return /^\/([A-Za-z0-9][A-Za-z0-9:._-]*)(?=\s|$)/.exec(text)?.[1];
}
