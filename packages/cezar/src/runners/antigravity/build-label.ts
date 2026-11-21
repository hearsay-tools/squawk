import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolveAntigravityExecutable } from './runtime-env.ts';

const execute = promisify(execFile);
let cached: { identity: string; label: Promise<string> } | undefined;

/** agy --version unpacks the native agent too; only executable changes justify another probe. */
export async function antigravityBuildLabel(bin: string): Promise<string> {
  const executable = resolveAntigravityExecutable(bin, process.env, process.cwd());
  if (!executable) throw new Error('Antigravity executable is unavailable');
  const file = await stat(executable, { bigint: true });
  const identity = [executable, file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs, file.mode].join(':');
  if (cached?.identity === identity) return cached.label;
  const entry = { identity, label: execute(executable, ['--version'], { timeout: 5000, maxBuffer: 32_768 }).then(({ stdout }) => {
    const version = /^Build label:\s*(.+)$/m.exec(stdout)?.[1]?.trim();
    if (!version) throw new Error('Antigravity build label is unavailable');
    return version;
  }) };
  cached = entry;
  try { return await entry.label; }
  catch (error) { if (cached === entry) cached = undefined; throw error; }
}
