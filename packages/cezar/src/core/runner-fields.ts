import { z } from 'zod';
import { registeredRunners } from './runner-registry.ts';

/**
 * Where a request or a saved file names runners (spec 2026-11-18-runner-definitions, decision 1).
 * The contract takes any runner id; a route refuses one that no runner registered, and a saved
 * file that names one stays unreadable, each with the issue the closed enum gave. A path is
 * dot-separated; `*` stands for each element of an array.
 */
export interface RunnerFields {
  /** Fields that hold one runner id. */
  readonly ids?: readonly string[];
  /** Objects keyed by runner id: a key that names no registered runner is dropped, as an object
   *  schema drops a key it does not know. */
  readonly keys?: readonly string[];
  /** An object keyed by runner id that refuses any other key, and the ids of removed runners it
   *  also keeps. */
  readonly strictKeys?: { readonly path: string; readonly also: readonly string[] };
}

type Located = { path: (string | number)[]; value: unknown };

/** Every value at `path` in `root`, with its concrete path. */
function locate(root: unknown, path: string): Located[] {
  let found: Located[] = [{ path: [], value: root }];
  for (const part of path.split('.')) {
    found = found.flatMap(({ path: at, value }): Located[] => {
      if (part === '*') return Array.isArray(value) ? value.map((item, index) => ({ path: [...at, index], value: item })) : [];
      return value && typeof value === 'object' && !Array.isArray(value) ? [{ path: [...at, part], value: (value as Record<string, unknown>)[part] }] : [];
    });
  }
  return found.filter(({ value }) => value !== undefined && value !== null);
}

function registeredIds(): readonly string[] {
  return registeredRunners().map(({ id }) => id);
}

function issuesAt(at: (string | number)[], schema: z.ZodType, value: unknown): z.core.$ZodIssue[] {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map(issue => ({ ...issue, path: [...at, ...issue.path] }));
}

/**
 * The issues of the runner ids in `data` that `known` does not list, worded as the closed enum
 * worded them. Drops the other keys of each `keys` object from `data`. `known` defaults to the
 * registered runners, read only when `data` names a runner.
 */
export function runnerFieldIssues(data: unknown, fields: RunnerFields, known: () => readonly string[] = registeredIds): z.core.$ZodIssue[] {
  const issues: z.core.$ZodIssue[] = [];
  for (const { path, value } of (fields.ids ?? []).flatMap(field => locate(data, field))) {
    // A process that registered no runner knows no id: every named id is unknown, so refuse it
    // without building an empty enum.
    const ids = known();
    issues.push(...issuesAt(path, ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.never(), value));
  }
  for (const { value } of (fields.keys ?? []).flatMap(field => locate(data, field))) {
    if (typeof value !== 'object') continue;
    const ids = new Set<string>(known());
    for (const key of Object.keys(value as object)) if (!ids.has(key)) delete (value as Record<string, unknown>)[key];
  }
  if (fields.strictKeys) {
    const { path: field, also } = fields.strictKeys;
    for (const { path, value } of locate(data, field)) {
      const shape = Object.fromEntries([...known(), ...also].map(id => [id, z.unknown().optional()]));
      issues.push(...issuesAt(path, z.strictObject(shape), value));
    }
  }
  return issues;
}
