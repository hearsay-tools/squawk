import { join } from 'node:path';

/**
 * OMP's (Oh My Pi's) agent dir under `env`, mirroring how omp 18.8.0 resolves it
 * (`packages/utils/src/dirs.ts`):
 *
 * - a profile — `OMP_PROFILE` when it is set at all, else `PI_PROFILE` — selects
 *   `<root>/profiles/<name>/agent`, and omp then ignores `PI_CODING_AGENT_DIR`;
 * - otherwise `PI_CODING_AGENT_DIR`, else `<root>/agent`;
 *
 * where `<root>` is `~/<PI_CONFIG_DIR or .omp>`. A host that exports a profile therefore moves the
 * DEFAULT account (see `profileEnvVar` in `core/agent-profiles.ts`). `default`, a blank value
 * and a name omp would refuse select no profile.
 */
export function resolveOmpAgentDir(env: NodeJS.ProcessEnv, home: string): string {
  const root = ompRootDir(env, home);
  const selected = (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE)?.trim();
  if (selected && isOmpProfileName(selected)) return join(root, 'profiles', selected, 'agent');
  return env.PI_CODING_AGENT_DIR?.trim() || join(root, 'agent');
}

function ompRootDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(home, env.PI_CONFIG_DIR?.trim() || '.omp');
}

/** omp's own profile-name rule (omp 18.8.0, `packages/utils/src/dirs.ts`). */
const OMP_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Windows device names omp refuses as a profile, with or without an extension. */
const OMP_RESERVED_NAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/** Whether omp accepts `name` as a profile of its own; `default` is omp's "no profile". */
function isOmpProfileName(name: string): boolean {
  return OMP_PROFILE_NAME_RE.test(name) && !name.endsWith('.') && name !== 'default'
    && !OMP_RESERVED_NAME_RE.test(name);
}
