import { allocateProjectSlug } from '../workspace/projects.ts';

/**
 * Allocate a profile id from the label (or, with no label, the folder name).
 *
 * Reuses the project allocator's shape, and deliberately its reserved set too: `default` is the
 * discovered profile here exactly as it is the boot alias there, so a folder called `default/`
 * becomes `default-2` and can never shadow it.
 */
export function allocateAgentProfileId(source: string, taken: Iterable<string>): string {
  // `allocateProjectSlug` already basenames its argument and enforces the shared
  // `^[a-z0-9][a-z0-9-]{0,63}$` shape, so `~/.claude-klaudiusz` slugs to `claude-klaudiusz`.
  return allocateProjectSlug(source, taken);
}

