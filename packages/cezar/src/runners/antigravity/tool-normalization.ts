import { z } from 'zod';
import type { UiToolItem } from '../../core/ui-events.ts';
const fields = z.record(z.string(), z.unknown());
const toolNames: Record<string, string> = {
  run_command: 'Bash', read_file: 'Read', view_file: 'Read', client_view_file: 'Read',
  edit_file: 'Edit', create_file: 'Write', write_to_file: 'Write', grep_search: 'Grep', find_by_name: 'Glob',
  start_subagent: 'Task', invoke_subagent: 'Task', search_web: 'WebSearch', read_url_content: 'WebFetch',
};
/** Provider permission titles decorate native tool names with Run/Running and a question mark. */
export function antigravityNativeToolName(update: Record<string, unknown>): string {
  if (typeof update.name === 'string') return update.name;
  return typeof update.title === 'string' ? update.title.replace(/^(Run |Running )/, '').replace(/\?$/, '') : '';
}
export function antigravityTool(update: Record<string, unknown>, previous?: UiToolItem): Partial<Omit<UiToolItem, 'id' | 'kind'>> {
  const input = fields.safeParse(update.rawInput).data;
  const title = typeof update.title === 'string' ? update.title : previous?.title ?? '';
  const nativeName = antigravityNativeToolName({ ...update, title });
  const name = toolNames[nativeName] ?? (update.kind === 'execute' ? 'Bash' : undefined);
  const command = input?.CommandLine ?? input?.command_line;
  const cwd = input?.Cwd ?? input?.working_dir;
  const result: Partial<Omit<UiToolItem, 'id' | 'kind'>> = {};
  if (name) result.name = name;
  if (command !== undefined) result.input = { command, ...(cwd === undefined ? {} : { cwd }) };
  Object.assign(result, toolOutput(update.rawOutput));
  if (name === 'Task') {
    result.toolKind = 'task';
    if (input && !Object.keys(input).length) result.input = previous?.input;
  }
  return result;
}

function toolOutput(value: unknown): Partial<UiToolItem> {
  const output = fields.safeParse(value).data;
  if (!output) return {};
  const exitCode = output.exitCode ?? output.exit_code;
  return { ...(typeof output.combinedOutput === 'string' ? { output: output.combinedOutput } : {}),
    ...(typeof exitCode === 'number' ? { exitCode } : {}) };
}
