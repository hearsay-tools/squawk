import { z } from 'zod';
import { knownRunnerIds } from './runner-registry.ts';

/** C0 controls + DEL. The same class `workspace/agent-accounts.ts` refuses in a config dir. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * The bound every stored runner id and every `registerRunner()` id shares (spec
 * 2026-11-24-plugin-loader-and-runner-kit, A3): a trimmed non-empty string, at most 64
 * characters, with no C0 or DEL control character. It does not ask the registry, so a stored
 * config keeps an id whose plugin is absent. HTTP writes stay on `registeredRunnerIdSchema`.
 */
export const storedRunnerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => !CONTROL_CHARS_RE.test(value), 'runner id must not contain control characters');

/**
 * A runner id the registry holds, read when each value parses. A value outside the registry is
 * refused with the issue the closed runner enum gave: code `invalid_value`, the
 * registered ids as `values`, the same message and path, and no later check on that value
 * (hearsay-tools/squawk#3936). `z.lazy` would keep the ids of its first parse.
 */
export function registeredRunnerIdSchema() {
  return z.custom<string>().superRefine((value, context) => {
    const ids = knownRunnerIds();
    if (typeof value !== 'string' || !ids.includes(value)) context.addIssue({ code: 'invalid_value', values: [...ids], input: value, continue: false });
  });
}
