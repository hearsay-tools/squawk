import { z } from 'zod';
import { knownRunnerIds } from './runner-registry.ts';

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
