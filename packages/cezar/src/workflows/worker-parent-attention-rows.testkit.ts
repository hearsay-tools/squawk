import { BUILT_IN_RUNNER_IDS } from '../runners/built-in.ts';

// The worker parent attention rows and their file groups. Apart from the cells, so the registration
// guard reads them without loading the run engine.

// Exhaustive transport classification: a new runner must provide either the real
// delayed-ACK race or an executable wire limitation, never an omitted/skip row.
const ACK_WIRES: Record<string, 'pipe-write' | 'protocol'> = {
  claude: 'pipe-write', codex: 'protocol', opencode: 'protocol', pi: 'protocol', omp: 'protocol',
};

export { ACK_WIRES };

export type AttentionRow =
 | { family: 'progress'; backend: string; mode: 'fresh' | 'continuation'; transport: 'ordinary' | 'pipe-write' | 'protocol' }
 | { family: 'spawn-ask'; backend: string; mode: 'fresh' | 'continuation' }
 | { family: 'completion' | 'timeout' | 'restart' | 'human-ask'; backend: string };
export const ATTENTION_GROUPS = {
 'fresh-ordinary-progress': BUILT_IN_RUNNER_IDS.map(backend => ({ family: 'progress', backend, mode: 'fresh', transport: 'ordinary' } as const)),
 'fresh-delayed-progress': BUILT_IN_RUNNER_IDS.map(backend => ({ family: 'progress', backend, mode: 'fresh', transport: ACK_WIRES[backend]! } as const)),
 'continued-ordinary-progress': BUILT_IN_RUNNER_IDS.map(backend => ({ family: 'progress', backend, mode: 'continuation', transport: 'ordinary' } as const)),
 'continued-delayed-progress': BUILT_IN_RUNNER_IDS.map(backend => ({ family: 'progress', backend, mode: 'continuation', transport: ACK_WIRES[backend]! } as const)),
 'fresh-spawn-ask': BUILT_IN_RUNNER_IDS.map(backend => ({ family: 'spawn-ask', backend, mode: 'fresh' } as const)),
 'continued-spawn-ask': BUILT_IN_RUNNER_IDS.map(backend => ({ family: 'spawn-ask', backend, mode: 'continuation' } as const)),
 'capacity-wake': BUILT_IN_RUNNER_IDS.flatMap(backend => { return (['completion', 'timeout'] as const).map(family => ({ family, backend } as const)); }),
 'restart-human-ask': BUILT_IN_RUNNER_IDS.flatMap(backend => { return (['restart', 'human-ask'] as const).map(family => ({ family, backend } as const)); }),
};
export type AttentionGroup = keyof typeof ATTENTION_GROUPS;
export function attentionRowKey(row: AttentionRow): string {
 return [row.backend, row.family, ...('mode' in row ? [row.mode] : []), ...('transport' in row ? [row.transport] : [])].join(':');
}
