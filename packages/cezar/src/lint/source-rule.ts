import { relative, resolve } from 'node:path';
import { blank } from './blank.ts';

/**
 * Shared paths and source inventory helpers (hearsay-tools/cezarion#2416). Oxlint rules use
 * ast-rule.ts; the runner uses the inventory helpers to check saved allowances and CSS.
 */

/** The repository root, for data a rule reads from the repository itself. */
export const repoRoot = resolve(import.meta.dirname, '../../../..');

/** One violation in one file. `line` counts from 1, `column` from 0. */
export interface Finding {
  line: number;
  column?: number;
  message: string;
}

let lastSource: string | undefined;
let lastCode = '';

/**
 * `blank()` of the last source asked for. Oxlint runs every rule on one file before the next,
 * and four rules read the same blanked text, so one entry saves three passes per file.
 */
export function blankOnce(source: string): string {
  if (source !== lastSource) {
    lastSource = source;
    lastCode = blank(source);
  }
  return lastCode;
}

/** The 1-based line of `offset` in `source`. */
export const lineAt = (source: string, offset: number): number => source.slice(0, offset).split('\n').length;

/** A path relative to `root`, with forward slashes. */
export const repoPath = (root: string, file: string): string => relative(root, file).replaceAll('\\', '/');

/** The subset of oxlint's rule context a source rule uses. */
export interface RuleContext {
  cwd: string;
  filename: string;
  sourceCode: { text: string };
  report(descriptor: { message: string; loc: { start: { line: number; column: number }; end: { line: number; column: number } } }): void;
}
