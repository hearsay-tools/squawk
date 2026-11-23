import type { Stats } from 'node:fs';
import { dirname } from 'node:path';

/** Only successful reads survive, bounded across repositories. Every caller still stats each file. */
export class ReceiptCache<T> {
  private readonly entries = new Map<string, { key: string; value: T }>();
  key(info: Stats): string {
    return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode, info.uid].join(':');
  }
  get(path: string, info: Stats): T | undefined {
    const entry = this.entries.get(path);
    if (entry?.key === this.key(info)) return structuredClone(entry.value);
    this.entries.delete(path);
    return undefined;
  }
  set(path: string, info: Stats, value: T): void {
    if (this.entries.size >= 20_000) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(path, { key: this.key(info), value: structuredClone(value) });
  }
  prune(directory: string, paths: ReadonlySet<string>): void {
    for (const path of this.entries.keys()) if (dirname(path) === directory && !paths.has(path)) this.entries.delete(path);
  }
}
