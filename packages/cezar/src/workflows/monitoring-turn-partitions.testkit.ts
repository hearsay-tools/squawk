import { PARITY_ROSTER, runsOn } from '../core/parity-classes.testkit.ts';

/** A file's monitoring cells: its modes and rows, on each runner its rows' class names
 *  (`core/parity-classes.testkit.ts`, hearsay-tools/cezarion#2991). */
export interface MonitoringPartition { modes: readonly ('fresh' | 'continuation')[]; rows: readonly string[] }
export const MONITORING_PARTITIONS = {
  fresh: {
    modes: ['fresh'],
    rows: ['M1', 'M2', 'M3', 'M19', 'M4', 'M21', 'M13', 'M7', 'M18', 'M5', 'M17'],
  },
  continuation: {
    modes: ['continuation'],
    rows: ['M1', 'M2', 'M3', 'M19', 'M4', 'M21', 'M14', 'M7', 'M18', 'M5'],
  },
} as const satisfies Record<string, MonitoringPartition>;
export type MonitoringPartitionName = keyof typeof MONITORING_PARTITIONS;
export const monitoringTurnFiles = Object.keys(MONITORING_PARTITIONS).map(name => `monitoring-turn-${name}.test.ts`);
export function monitoringCells(partitions: readonly MonitoringPartition[]): string[] {
  return partitions.flatMap(partition => PARITY_ROSTER.flatMap(runner => partition.modes.flatMap(mode => partition.rows
    .filter(row => runsOn('monitoring-turn', row, runner)).map(row => `${runner}/${mode}/${row}`))));
}
export const expectedMonitoringCells = PARITY_ROSTER.flatMap(runner => [
  ...['fresh', 'continuation'].flatMap(mode => ['M1', 'M2', 'M3', 'M4', 'M5', 'M7', 'M18', 'M19', 'M21'].map(row => `${runner}/${mode}/${row}`)),
  `${runner}/fresh/M13`, `${runner}/continuation/M14`, `${runner}/fresh/M17`,
].filter(cell => runsOn('monitoring-turn', cell.split('/')[2], runner)));
