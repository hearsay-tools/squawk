import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { buildChildEnv } from './agent-env.ts';

/** The spawn a model probe uses; tests pass their own. */
export type ModelProbeSpawnImpl = (
  bin: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

/** Start a host model probe in `cwd` under the backend's own child environment. */
export function spawnModelProbe(
  backend: string,
  bin: string,
  args: readonly string[],
  cwd: string,
  spawnImpl: ModelProbeSpawnImpl = nodeSpawn,
): ChildProcessWithoutNullStreams {
  return spawnImpl(bin, [...args], { cwd, env: buildChildEnv({ backend }) });
}
