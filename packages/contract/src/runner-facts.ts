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
   * `pushed`: the server refreshes the model catalog in the background, serves the cached copy on
   * request and pushes each change on the `models:<runner>` topic. `on-request`: each request
   * discovers the catalog, through the server's short cache.
   */
  readonly modelCatalogDelivery: 'pushed' | 'on-request';
  /**
   * `catalog-only`: the effort levels come only from the runner's own discovered catalog; without
   * them the picker offers only auto. `catalog-or-generic`: without catalog levels the picker
   * offers every generic level.
   */
  readonly effortLevels: 'catalog-only' | 'catalog-or-generic';
  /**
   * Which model ids the runner serves. `own`: its own provider's ids, so another runner's known
   * preset conflicts with it. `provider-spanning`: `provider/model` ids of every configured
   * provider, so an id it lists belongs to no runner alone. `any-provider`: bare ids of every
   * provider, so no id conflicts with it.
   */
  readonly modelIdScope: 'own' | 'provider-spanning' | 'any-provider';
  /** `steer`: input reaches the agent during its turn. `boundary`: input waits for the turn to end. */
  readonly inputMode: 'steer' | 'boundary';
}

export const RUNNER_COCKPIT_FACTS = {
  claude: {
    displayName: 'Claude Code', modelListName: 'Claude', modelCatalogDelivery: 'on-request', effortLevels: 'catalog-or-generic', modelIdScope: 'own', inputMode: 'steer',
  },
  codex: {
    displayName: 'Codex', modelListName: 'Codex', modelCatalogDelivery: 'on-request', effortLevels: 'catalog-or-generic', modelIdScope: 'own', inputMode: 'steer',
  },
  opencode: {
    displayName: 'OpenCode', modelListName: 'OpenCode', modelCatalogDelivery: 'on-request', effortLevels: 'catalog-or-generic', modelIdScope: 'provider-spanning', inputMode: 'steer',
  },
  pi: {
    displayName: 'pi', modelListName: 'Pi', modelCatalogDelivery: 'on-request', effortLevels: 'catalog-or-generic', modelIdScope: 'provider-spanning', inputMode: 'steer',
  },
  cursor: {
    displayName: 'Cursor', modelListName: 'Cursor', modelCatalogDelivery: 'pushed', effortLevels: 'catalog-only', modelIdScope: 'any-provider', inputMode: 'boundary',
  },
  omp: {
    displayName: 'OMP', modelListName: 'OMP', modelCatalogDelivery: 'on-request', effortLevels: 'catalog-or-generic', modelIdScope: 'provider-spanning', inputMode: 'steer',
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

/** The runners whose cockpit facts match, in the table's order. */
export function cockpitRunnersWhere(matches: (facts: CockpitRunnerFacts) => boolean): Runner[] {
  return (Object.keys(RUNNER_COCKPIT_FACTS) as Runner[]).filter(runner => matches(RUNNER_COCKPIT_FACTS[runner]));
}
