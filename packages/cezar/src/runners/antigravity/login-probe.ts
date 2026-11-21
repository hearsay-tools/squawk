import type { RunnerLoginStatus } from '../../core/runner-definition.ts';
// --version proves installation only. Cockpit sign-in is hearsay-tools/squawk#4003.
export const antigravityLogin: RunnerLoginStatus = { parse: () => null };
