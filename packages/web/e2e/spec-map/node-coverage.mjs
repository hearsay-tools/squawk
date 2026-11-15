import { readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { takeCoverage } from 'node:v8';

let sequence = 0;

export function flushCoverage(directory) {
  takeCoverage();
  // Node names each dump with millisecond precision. Its final signal/exit dump
  // can overwrite an explicit flush from the same millisecond after counters reset.
  const prefix = `coverage-${process.pid}-`;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix) || !/^coverage-\d+-\d+-\d+\.json$/.test(name)) continue;
    renameSync(join(directory, name), join(directory, `${prefix}saved-${sequence++}.json`));
  }
}
