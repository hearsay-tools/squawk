import type { SkillInputIdentity } from '@open-mercato/cezar-api-client'
import type { ThreadEntry } from './thread-state'

/** Only an adapter-correlated expansion can echo a saved input. Old items stay visible. */
export function isSkillInputEcho(entry: ThreadEntry, source: SkillInputIdentity['source']): boolean {
  return entry.kind === 'message' && entry.role === 'user' && entry.skillInput?.source === source &&
    typeof entry.skillInput.id === 'string' && entry.skillInput.id !== ''
}
