import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Home } from '../home/home.ts';
import { removeRelease } from './cli-storage.ts';

/** Builds a minimal gzipped POSIX tar archive containing one executable entry for managed CLI tests. */
export function buildTestCliArchive(version: string, name: string, kind = '0'): Buffer {
  const contents = Buffer.from(`#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000755\0', 100);
  header.write(contents.length.toString(8).padStart(11, '0') + '\0', 124);
  header.fill(32, 148, 156);
  header.write(kind, 156);
  header.write('ustar\0', 257);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, contents, Buffer.alloc(512 - contents.length % 512), Buffer.alloc(1024)]));
}

/** Unseals every managed CLI release directory inside a sandbox home and removes the sandbox root. */
export function cleanupManagedCliHome(home: Home): void {
  const tools = join(home.data, 'tools');
  if (existsSync(tools)) {
    for (const runner of readdirSync(tools)) {
      const runnerDir = join(tools, runner);
      for (const target of readdirSync(runnerDir)) {
        const versions = join(runnerDir, target, 'versions');
        if (!existsSync(versions)) continue;
        for (const release of readdirSync(versions)) removeRelease(join(versions, release));
      }
    }
  }
  if (home.rootOverride) rmSync(home.rootOverride, { recursive: true, force: true });
}
