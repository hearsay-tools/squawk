import { z, type UiToolItem } from '@hearsay-tools/squawk/plugin';
import { toolDisplay } from '@hearsay-tools/squawk/plugin/runtime';
import { ANTIGRAVITY_MCP_NAME } from './mcp-name.ts';
const fields = z.record(z.string(), z.unknown());
const toolNames: Record<string, string> = {
  run_command: 'Bash', read_file: 'Read', edit_file: 'Edit', write_file: 'Write',
  invoke_subagent: 'Task', search_web: 'WebSearch',
};
const nonEmpty = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
/** The native tool name: the CLI sends it as `name`; a title decorates it with Run/Running. */
export function antigravityNativeToolName(update: Record<string, unknown>): string {
  if (typeof update.name === 'string') return update.name;
  return typeof update.title === 'string' ? update.title.replace(/^(Run |Running )/, '').replace(/\?$/, '') : '';
}
/**
 * The CLI names an MCP tool `mcp_<server>_<tool>` and sends no server field. Squawk's own server
 * and the shared per-session name `cezar_ci_<32 hex>` are known by shape; another server's name is
 * read up to its first underscore.
 */
export function antigravityMcpTool(update: Record<string, unknown>): { server: string; tool: string } | undefined {
  const name = antigravityNativeToolName(update);
  const own = `mcp_${ANTIGRAVITY_MCP_NAME}_`;
  if (name.startsWith(own) && name.length > own.length) return { server: ANTIGRAVITY_MCP_NAME, tool: name.slice(own.length) };
  const match = /^mcp_(cezar_ci_[0-9a-f]{32}|[A-Za-z0-9-]+)_(.+)$/.exec(name);
  return match ? { server: match[1]!, tool: match[2]! } : undefined;
}
function normalizeTaskInput(input: Record<string, unknown>): { input: Record<string, unknown>; title: string } {
  const role = nonEmpty(input.Role);
  const prompt = nonEmpty(input.Prompt);
  const typeName = nonEmpty(input.TypeName);
  const normalized = {
    ...input,
    ...(typeName && input.subagent_type === undefined ? { subagent_type: typeName } : {}),
    ...(role && input.description === undefined ? { description: role } : {}),
    ...(prompt && input.prompt === undefined ? { prompt } : {}),
  };
  return { input: normalized, title: toolDisplay('Task', normalized).title };
}
export function antigravityTool(update: Record<string, unknown>, previous?: UiToolItem): Partial<Omit<UiToolItem, 'id' | 'kind'>> {
  const input = fields.safeParse(update.rawInput).data;
  const title = typeof update.title === 'string' ? update.title : previous?.title ?? '';
  const nativeName = antigravityNativeToolName({ ...update, title });
  const name = toolNames[nativeName] ?? (update.kind === 'execute' ? 'Bash' : undefined);
  const command = input?.CommandLine;
  const result: Partial<Omit<UiToolItem, 'id' | 'kind'>> = {};
  if (name) result.name = name;
  const mcp = antigravityMcpTool({ ...update, title });
  if (mcp) { result.name = mcp.tool; result.title = mcp.tool; }
  if (command !== undefined) result.input = { command, ...(input?.Cwd === undefined ? {} : { cwd: input.Cwd }) };
  // The native timer: Squawk reads its delay as `delaySeconds` (workflows/run/turn-markers.ts).
  if (nativeName === 'schedule' && input) result.input = { delaySeconds: input.DurationSeconds, prompt: input.Prompt };
  Object.assign(result, toolOutput(update.rawOutput));
  if (name === 'Task') {
    result.toolKind = 'task';
    if (input && Object.keys(input).length) Object.assign(result, normalizeTaskInput(input));
    else if (previous) {
      if (input) result.input = previous.input;
      if (previous.title) result.title = previous.title;
    }
  }
  return result;
}

/** Normalizes a child transcript tool call (`name`, `args`) into display fields for a nested `UiToolItem`. */
export function antigravityTranscriptTool(nativeName: string, rawArgs: unknown): Pick<UiToolItem, 'name' | 'toolKind' | 'title' | 'input'> {
  const args = fields.safeParse(rawArgs).data;
  const mcp = antigravityMcpTool({ name: nativeName });
  if (mcp) return { name: mcp.tool, toolKind: 'other', title: mcp.tool, ...(args ? { input: args } : {}) };
  const name = toolNames[nativeName] ?? nativeName;
  const normalized = transcriptToolInput(name, args);
  const display = toolDisplay(name, normalized);
  return { name, toolKind: display.toolKind, title: display.title, ...(normalized ? { input: normalized } : {}) };
}

function transcriptToolInput(name: string, args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args) return undefined;
  if (name === 'Bash' && args.CommandLine !== undefined) return { command: args.CommandLine, ...(args.Cwd === undefined ? {} : { cwd: args.Cwd }) };
  if ((name === 'Read' || name === 'Edit' || name === 'Write') && typeof args.Path === 'string') return { ...args, path: args.Path };
  if (name === 'Task') return normalizeTaskInput(args).input;
  return args;
}

function toolOutput(value: unknown): Partial<UiToolItem> {
  const output = fields.safeParse(value).data;
  if (!output) return {};
  const exitCode = output.exit_code;
  return { ...(typeof output.output === 'string' ? { output: output.output } : {}),
    ...(typeof exitCode === 'number' ? { exitCode } : {}) };
}
