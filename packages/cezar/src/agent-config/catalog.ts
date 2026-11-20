import type { ConfigFileDef, RunnerConfigFile } from '../core/runner-config-files.ts';
import { registeredRunners } from '../core/runner-registry.ts';

/**
 * Maintained catalog of native config-file paths, formats, precedence descriptions and
 * documentation URLs: each registered runner's `configFiles`. Unknown files are not guessed.
 * Account relocation and identity readers own their separate native-file knowledge.
 */

/**
 * The whole catalog, in presentation order: per runner, in registration order. A file's readers
 * are the runners that list it, in registration order. A file that several runners list
 * (`<repo>/AGENTS.md`) appears once, at its last listing, so it follows every runner's own files.
 */
export function listConfigFiles(): ConfigFileDef[] {
  const readers = new Map<RunnerConfigFile, string[]>();
  for (const { id, configFiles } of registeredRunners()) {
    for (const file of configFiles.files) {
      const runners = readers.get(file) ?? [];
      // Delete before set: the entry moves to its last listing.
      readers.delete(file);
      readers.set(file, runners.includes(id) ? runners : [...runners, id]);
    }
  }
  return [...readers].map(([file, runners]) => ({ ...file, runners }));
}

/** Look up one entry by its stable id, or undefined when the id is unknown. */
export function findConfigFile(id: string): ConfigFileDef | undefined {
  return listConfigFiles().find((f) => f.id === id);
}
