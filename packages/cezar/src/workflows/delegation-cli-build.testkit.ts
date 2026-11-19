import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, transform } from 'esbuild';

const entry = fileURLToPath(new URL('../index.ts', import.meta.url));

/** Compile once for a fixture, preserving each module's source asset base. */
export async function buildDelegationCli(sourceEntry: string = entry) {
  const directory = mkdtempSync(join(tmpdir(), 'cez-delegation-cli-'));
  const compiledEntry = join(directory, 'cli.mjs');
  const close = () => rmSync(directory, { recursive: true, force: true });
  try {
    symlinkSync(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(directory, 'node_modules'), 'junction');
    await build({
      entryPoints: [sourceEntry], outfile: compiledEntry, bundle: true,
      platform: 'node', format: 'esm', packages: 'external',
      plugins: [{ name: 'source-module-urls', setup(builder) {
        builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
          const result = await transform(readFileSync(path, 'utf8'), {
            loader: 'ts', format: 'esm',
            define: { 'import.meta.url': JSON.stringify(pathToFileURL(path).href) },
          });
          return { contents: result.code, loader: 'js' };
        });
      } }],
    });
    return { entry: compiledEntry, close };
  } catch (error) { close(); throw error; }
}
