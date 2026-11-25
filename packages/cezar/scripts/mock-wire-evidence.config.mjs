import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  resolve: {
    alias: [
      { find: /^@hearsay-tools\/squawk\/plugin$/, replacement: fileURLToPath(new URL('../src/plugin/index.ts', import.meta.url)) },
      { find: /^@hearsay-tools\/squawk\/plugin\/runtime$/, replacement: fileURLToPath(new URL('../src/plugin/runtime.ts', import.meta.url)) },
      { find: /^@hearsay-tools\/squawk\/plugin\/model-settings$/, replacement: fileURLToPath(new URL('../src/plugin/model-settings.ts', import.meta.url)) },
      { find: /^@hearsay-tools\/squawk\/plugin\/managed-cli$/, replacement: fileURLToPath(new URL('../src/plugin/managed-cli.ts', import.meta.url)) },
      { find: /^@hearsay-tools\/squawk\/plugin\/pi-rpc$/, replacement: fileURLToPath(new URL('../src/plugin/pi-rpc.ts', import.meta.url)) },
    ],
  },
  test: {
    include: ['.ai/scripts/mock-wire-evidence.ts'],
    setupFiles: ['packages/cezar/vitest.setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
