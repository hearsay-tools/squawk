import type { Runner } from './runner.ts';

/**
 * What the cockpit and the server both need to know about one runner, declared once per runner
 * id (hearsay-tools/squawk#3642). Shared code reads a row instead of comparing runner ids, so a
 * new runner needs one new row and no new branch. The server's own wire facts live in
 * `RUNNER_FACTS` (`packages/cezar/src/core/runner-facts.ts`); its test checks that the two agree
 * where they state the same fact.
 */
export interface CockpitRunnerFacts {
  /** The runner's name on provider, account and conversation surfaces and in server messages. */
  readonly displayName: string;
  /** The runner's name in model discovery messages and in the model picker's status line. */
  readonly modelListName: string;
  /**
   * Which model ids the runner serves. `own`: its own provider's ids, so another runner's known
   * preset conflicts with it. `provider-spanning`: `provider/model` ids of every configured
   * provider, so an id it lists belongs to no runner alone.
   */
  readonly modelIdScope: 'own' | 'provider-spanning';
}

export const RUNNER_COCKPIT_FACTS = {
  claude: {
    displayName: 'Claude Code', modelListName: 'Claude', modelIdScope: 'own',
  },
  codex: {
    displayName: 'Codex', modelListName: 'Codex', modelIdScope: 'own',
  },
  opencode: {
    displayName: 'OpenCode', modelListName: 'OpenCode', modelIdScope: 'provider-spanning',
  },
  pi: {
    displayName: 'pi', modelListName: 'Pi', modelIdScope: 'provider-spanning',
  },
  omp: {
    displayName: 'OMP', modelListName: 'OMP', modelIdScope: 'provider-spanning',
  },
} as const satisfies Readonly<Record<Runner, CockpitRunnerFacts>>;

/** The display name of a runner. */
export function runnerDisplayName(runner: Runner): string {
  return RUNNER_COCKPIT_FACTS[runner].displayName;
}

/** The runner's name in model discovery messages. */
export function runnerModelListName(runner: Runner): string {
  return RUNNER_COCKPIT_FACTS[runner].modelListName;
}
