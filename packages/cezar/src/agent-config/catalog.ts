import type { ConfigFileDef } from '../core/runner-config-files.ts';
import { registeredRunners } from '../core/runner-registry.ts';

/**
 * Maintained catalog of native config-file paths, formats, precedence descriptions and
 * documentation URLs: each registered runner's `configFiles`. Unknown files are not guessed.
 * Account relocation and identity readers own their separate native-file knowledge.
 */

/**
 * The whole catalog, in presentation order: per runner, in registration order. A file that
 * several runners list (`<repo>/AGENTS.md`) appears once, at its last listing, so it follows
 * every runner's own files.
 */
export function listConfigFiles(): ConfigFileDef[] {
  const files = registeredRunners().flatMap((definition) => definition.configFiles);
  return files.filter((file, index) => files.lastIndexOf(file) === index);
}

/** Look up one entry by its stable id, or undefined when the id is unknown. */
export function findConfigFile(id: string): ConfigFileDef | undefined {
  return listConfigFiles().find((f) => f.id === id);
}
