import type { RunnerEnv } from '../../core/runner-definition.ts';
import { MULTI_PROVIDER_PREFIXES } from '../../core/agent-env.ts';

/** OMP's env allow-list (the `env` part). Data only. */
export const OMP_ENV = {
  allowPrefixes: [
    // OMP (Oh My Pi) is pi's fork and selects models the same `provider/model` way, so it gets the
    // same multi-provider set. Not `CLAUDE_`, for pi's reason in runners/pi/env.ts. `OMP_` is its
    // own config and `PI_` is kept because OMP still reads `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`
    // (OMP v18.4.11; `can1357/oh-my-pi` `docs/environment-variables.md` at main @ 7318a70cf4ed).
    // The reverse does not hold: pi gets no `OMP_`. Both prefixes also carry a host-exported
    // `PI_CODING_AGENT_DIR` / `OMP_PROFILE` to every default-account session, which is how a host
    // value moves the default account (`profileEnvVar` in `core/agent-profiles.ts`).
    'OMP_',
    'PI_',
    ...MULTI_PROVIDER_PREFIXES,
  ],
} as const satisfies RunnerEnv;
