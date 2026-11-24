import { parseConfigContent, type AgentRunSpec } from '@hearsay-tools/squawk/plugin';

/**
 * The OpenCode runtime config a session already carries (`OPENCODE_CONFIG_CONTENT`), read from
 * its extra env first, then the process env; `{}` when none is supplied. Squawk merges its own
 * entries into it, and OpenCode gives this config precedence over its config files. Throws
 * `error` when the supplied text is not a JSONC object, or when `field` is present and fails
 * `valid`.
 */
export function suppliedOpenCodeConfig(
  env: Record<string, string> | undefined,
  field: string,
  valid: (value: unknown) => boolean,
  error: string,
): Record<string, unknown> {
  const supplied = env?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT;
  if (!supplied) return {};
  try {
    const parsed: unknown = parseConfigContent(supplied, 'jsonc');
    if (!isObject(parsed) || (parsed[field] !== undefined && !valid(parsed[field]))) throw new Error();
    return parsed;
  } catch { throw new Error(error); }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Runtime config has highest precedence; merge only our collision-resistant server. */
export function ciOpenCodeEnv(spec: AgentRunSpec): Record<string, string> | undefined {
  if (!spec.squawkTools) return spec.env;
  const config = suppliedOpenCodeConfig(spec.env, 'mcp', isObject, 'CI tool unavailable: invalid supplied OpenCode runtime configuration');
  const { name, command, args } = spec.squawkTools;
  const existing = isObject(config.mcp) ? config.mcp : {};
  if (Object.hasOwn(existing, name)) throw new Error('CI tool unavailable: OpenCode server name collision');
  return { ...spec.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, mcp: { ...existing, [name]: { type: 'local', command: [command, ...args], enabled: true } } }) };
}
