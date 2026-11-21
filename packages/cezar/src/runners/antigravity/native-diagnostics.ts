import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { redactBrowserSignInDetails } from '../../core/browser-sign-in-error.ts';
import { collectSecretValues, redactSecrets } from '../../core/secret-redaction.ts';

const MAX_FILES = 4;
const TAIL_BYTES = 16_384;

export function redactAntigravityDiagnostics(value: string, env: NodeJS.ProcessEnv): string {
  return redactBrowserSignInDetails(redactSecrets(value, collectSecretValues(env)));
}

function completeTail(buffer: Buffer, cut: boolean): string {
  const tail = buffer.toString('utf8');
  // A cut could remove a credential's field name. Keep only complete lines.
  if (!cut) return tail;
  const newline = tail.indexOf('\n');
  return newline < 0 ? '' : tail.slice(newline + 1);
}

async function nativeLogTail(path: string): Promise<string> {
  // Do not follow native log aliases or a symlink substituted after readdir.
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return '';
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    return completeTail(buffer.subarray(0, bytesRead), start > 0);
  } finally { await file.close(); }
}

/** Preserve bounded native evidence in the server log before its private TMPDIR is removed. */
export async function logAntigravityFailure(temp: string, context: string, cause: unknown, env: NodeJS.ProcessEnv, stderr = ''): Promise<void> {
  const safe = (value: string) => redactAntigravityDiagnostics(value, env);
  const tails: string[] = [];
  if (stderr) {
    const bytes = Buffer.from(stderr);
    tails.push(safe(`stderr:\n${completeTail(bytes.subarray(-TAIL_BYTES), bytes.length > TAIL_BYTES)}`));
  }
  try {
    const entries = await readdir(temp, { withFileTypes: true });
    const files = entries.filter(entry => entry.isFile() && /\.log\.(?:INFO|ERROR)\./.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name)).slice(0, MAX_FILES);
    for (const entry of files) {
      const tail = await nativeLogTail(join(temp, entry.name)).catch(() => '');
      if (tail) tails.push(safe(`${entry.name}:\n${tail}`));
    }
  } catch { /* Missing/unreadable diagnostics must not replace the native failure. */ }
  console.error(`Antigravity ${context} failed:`, safe(inspect(cause, { customInspect: false })).slice(0, TAIL_BYTES),
    tails.length ? tails.join('\n') : 'No native INFO/ERROR log tail available.');
}
