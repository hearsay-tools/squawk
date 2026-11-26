import { parseArgs } from 'node:util';
import { homeFileSchema } from '@open-mercato/cezar-contract/home-recovery';

export function isBackupFile(value: string): value is string {
  return homeFileSchema.safeParse(value).success;
}

/** The newest allowed backup time for `--at`; NaN when the value is not an ISO UTC time. */
export function restoreLimit(at: string | undefined): number {
  if (at === undefined) return Infinity;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(at) ? Date.parse(at) : NaN;
}

/** The verbs `cez backup` accepts. */
export const BACKUP_COMMANDS = ['list', 'restore', 'import', 'ignore'] as const;
export type BackupCommand = typeof BACKUP_COMMANDS[number];
export const isBackupCommand = (name: string | undefined): name is BackupCommand => (BACKUP_COMMANDS as readonly (string | undefined)[]).includes(name);

/** The one parser for `backup` arguments: the command and its home entry read the same options. */
export function parseBackupArgs(argv: readonly string[]) {
  return parseArgs({ args: [...argv], allowPositionals: true, options: {
    at: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
}

/** `restore <file> [--at <time>]` with one supported file and no help; anything else is not a restore. */
export function restoreRequest({ values, positionals }: ReturnType<typeof parseBackupArgs>): { file: string; at: string | undefined } | undefined {
  const [command, file] = positionals;
  if (values.help || command !== 'restore' || positionals.length !== 2 || file === undefined || !isBackupFile(file)) return undefined;
  return { file, at: values.at };
}

/** A restore that will run: its arguments parse and its time is valid. Anything else is help or a usage error. */
export function isValidRestore(argv: readonly string[]): boolean {
  try {
    const request = restoreRequest(parseBackupArgs(argv));
    return request !== undefined && !Number.isNaN(restoreLimit(request.at));
  } catch { return false; }
}

