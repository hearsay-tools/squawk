import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';

// The worker parent attention rows and their file groups. Apart from the cells, so the registration
// guard reads them without loading the run engine.

// Exhaustive transport classification: a new runner must provide either the real
// delayed-ACK race or an executable wire limitation, never an omitted/skip row.
const ACK_WIRES = {
  claude: 'pipe-write', codex: 'protocol', opencode: 'protocol', pi: 'protocol', omp: 'protocol',
} as const satisfies Record<RunnerId, 'pipe-write' | 'protocol'>;

export { ACK_WIRES };

export type AttentionRow =
 | { family: 'progress'; backend: RunnerId; mode: 'fresh' | 'continuation'; transport: 'ordinary' | 'pipe-write' | 'protocol' }
 | { family: 'spawn-ask'; backend: RunnerId; mode: 'fresh' | 'continuation' }
 | { family: 'completion' | 'timeout' | 'restart' | 'human-ask'; backend: RunnerId };
export const ATTENTION_GROUPS = {
 'fresh-ordinary-progress': RUNNER_IDS.map(backend => ({ family: 'progress', backend, mode: 'fresh', transport: 'ordinary' } as const)),
 'fresh-delayed-progress': RUNNER_IDS.map(backend => ({ family: 'progress', backend, mode: 'fresh', transport: ACK_WIRES[backend] } as const)),
 'continued-ordinary-progress': RUNNER_IDS.map(backend => ({ family: 'progress', backend, mode: 'continuation', transport: 'ordinary' } as const)),
 'continued-delayed-progress': RUNNER_IDS.map(backend => ({ family: 'progress', backend, mode: 'continuation', transport: ACK_WIRES[backend] } as const)),
 'fresh-spawn-ask': RUNNER_IDS.map(backend => ({ family: 'spawn-ask', backend, mode: 'fresh' } as const)),
 'continued-spawn-ask': RUNNER_IDS.map(backend => ({ family: 'spawn-ask', backend, mode: 'continuation' } as const)),
 'capacity-wake': RUNNER_IDS.flatMap(backend => { return (['completion', 'timeout'] as const).map(family => ({ family, backend } as const)); }),
 'restart-human-ask': RUNNER_IDS.flatMap(backend => { return (['restart', 'human-ask'] as const).map(family => ({ family, backend } as const)); }),
};
export type AttentionGroup = keyof typeof ATTENTION_GROUPS;
export function attentionRowKey(row: AttentionRow): string {
 return [row.backend, row.family, ...('mode' in row ? [row.mode] : []), ...('transport' in row ? [row.transport] : [])].join(':');
}
