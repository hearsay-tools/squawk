import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nativeMockPath as kitNativeMockPath } from '@hearsay-tools/squawk/plugin/runtime';
import { nativeMockPath } from './native-mock.ts';

const SCRIPTS_DIR = fileURLToPath(new URL('../../scripts', import.meta.url));

describe('nativeMockPath', () => {
  it('is re-exported on @hearsay-tools/squawk/plugin/runtime', () => {
    expect(kitNativeMockPath).toBe(nativeMockPath);
  });

  it.each([
    'mock-claude.mjs',
    'mock-codex-app-server.mjs',
    'mock-opencode-serve.mjs',
    'mock-pi-rpc.mjs',
    'mock-omp-rpc.mjs',
    'mock-acp.mjs',
  ])('resolves shipped mock script %s inside the running copy scripts/ folder', (script) => {
    const resolved = nativeMockPath({ script });
    expect(resolved).toBe(join(SCRIPTS_DIR, script));
    expect(existsSync(resolved)).toBe(true);
  });

  it('throws an error naming the script when the file is absent', () => {
    expect(() => nativeMockPath({ script: 'mock-does-not-exist.mjs' }))
      .toThrow(/mock-does-not-exist\.mjs/);
  });

  it.each(['', '.', '..', '../package.json', 'nested/mock-claude.mjs', 'nested\\mock-claude.mjs'])(
    'refuses invalid or escaping script name %j',
    (script) => {
      expect(() => nativeMockPath({ script })).toThrow(script ? new RegExp(script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : /""/);
    },
  );
});
