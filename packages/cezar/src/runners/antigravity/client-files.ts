import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z, type ToolGrant } from '@hearsay-tools/squawk/plugin';
import { AcpRpcError } from '@hearsay-tools/squawk/plugin/acp';
const requestSchema = z.object({ path: z.string(), line: z.number().int().positive().optional(), limit: z.number().int().positive().optional() });
/** Advertising reads moves view_file onto the client, where Read admission can be enforced. */
export async function antigravityReadFile(value: unknown, cwd: string, grant: ToolGrant): Promise<{ content: string }> {
  if (grant.kind !== 'unset' && !grant.tools.includes('Read')) throw new AcpRpcError(-32000, 'Read is not granted for this task');
  const request = requestSchema.parse(value);
  const path = resolve(cwd, request.path);
  if ((await stat(path)).size > 8 * 1024 * 1024) throw new AcpRpcError(-32000, 'File exceeds the client read limit');
  const content = await readFile(path, 'utf8');
  if (request.line === undefined && request.limit === undefined) return { content };
  const start = (request.line ?? 1) - 1;
  return { content: content.split('\n').slice(start, request.limit === undefined ? undefined : start + request.limit).join('\n') };
}
