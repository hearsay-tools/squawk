import { expect } from 'vitest';

// What a runner's mock records on its wire (`CEZ_MOCK_ARGS_FILE` and `CEZ_MOCK_STDIN_FILE`, one
// JSON row per line), and the shape of the reader each runner keeps in
// `runners/<id>/session-wire.testkit.ts`. `runner-session-wires.testkit.ts` loads the readers.

/** One recorded row: an argv array (a launch) or an object (a JSON-RPC or HTTP request, or a stdin message). */
export type WireRow = Record<string, unknown> | unknown[];

/** Both files a mock records: `args` (`CEZ_MOCK_ARGS_FILE`) and `stdin` (`CEZ_MOCK_STDIN_FILE`). */
export interface NativeRecording {
  readonly args: WireRow[];
  readonly stdin: WireRow[];
}

/** A native skill trigger to look for: the skill, its arguments and the context sent with it ('' for none). */
export interface SkillTriggerInput {
  readonly name: string;
  readonly args: string;
  readonly context: string;
}

/**
 * How a runner's native wire shows a resumed session, a fresh one, a started turn and its effort
 * (each reads the `args` rows), and where its prompts, its system prompt and its native skill
 * triggers sit in the whole recording.
 */
export interface SessionWire {
  resumed(wire: WireRow[]): string[];
  freshSessions(wire: WireRow[]): number;
  started(wire: WireRow[]): boolean;
  effort(wire: WireRow[]): string | undefined;
  /** Each prompt the mock took to start a turn, in order; a prompt's text parts joined by a newline. */
  prompts(recording: NativeRecording): string[];
  /** Each input the mock took into an open turn apart from `prompts` (Codex `turn/steer`); none
   *  where a steered input arrives as a prompt. */
  steers(recording: NativeRecording): string[];
  /** The system prompt of the first launch: its own argv flag, or the opening message that carries
   *  it in-thread. Undefined when the wire that should carry it does not. */
  systemPrompt(recording: NativeRecording): string | undefined;
  /** The text each native trigger of skill `name` carries (its arguments and the context sent with it), in order. */
  skillTriggers(recording: NativeRecording, name: string): string[];
  /** Fails unless the wire's native trigger runs `trigger.name` with its arguments and context
   *  exactly as this wire must carry them (`core/runner-skill-trigger.testkit.ts`). */
  expectSkillTrigger(recording: NativeRecording, trigger: SkillTriggerInput): void;
}

export function wireRecord(row: WireRow): Record<string, unknown> | undefined {
  return Array.isArray(row) ? undefined : row;
}

export function wireArgv(row: WireRow): string[] | undefined {
  return Array.isArray(row) ? row.map(String) : undefined;
}

/** Each value of `flag` across the recorded command lines. */
export function flagValues(wire: WireRow[], flag: string): string[] {
  return wire.flatMap((row) => {
    const args = wireArgv(row);
    const at = args?.indexOf(flag) ?? -1;
    return at >= 0 ? [args![at + 1]!] : [];
  });
}

/** The `userText` of each stdin message: the prompt of a wire that writes it to the agent's stdin. */
export function stdinPrompts({ stdin }: NativeRecording): string[] {
  return stdin.flatMap(row => {
    const text = wireRecord(row)?.userText;
    return text === undefined ? [] : [String(text)];
  });
}

/** The `--append-system-prompt` value of the first recorded command line, or undefined without the flag. */
export function appendedSystemPrompt({ args }: NativeRecording): string | undefined {
  const argv = args.map(wireArgv).find(Boolean) ?? [];
  const at = argv.indexOf('--append-system-prompt');
  return at >= 0 ? argv[at + 1] ?? '' : undefined;
}

/** The text parts of one recorded request, joined by a newline. */
export function joinedParts(parts: unknown): string {
  return Array.isArray(parts) ? parts.map(part => (part as { text?: string }).text ?? '').join('\n') : '';
}

/** Each stdin message that runs skill `name` as the slash command `/skill:<name>`, in order. */
export function slashSkillTriggers({ args, stdin }: NativeRecording, name: string): string[] {
  return stdinPrompts({ args, stdin: [...args, ...stdin] }).filter(text => text.startsWith(`/skill:${name}`));
}

/** Fails unless the first `/skill:<name>` message is exactly the command, its arguments and its context. */
export function expectSlashSkillTrigger(recording: NativeRecording, { name, args, context }: SkillTriggerInput): void {
  expect(slashSkillTriggers(recording, name)[0]).toBe(`/skill:${name} ${args}${context ? `\n\n${context}` : ''}`);
}
