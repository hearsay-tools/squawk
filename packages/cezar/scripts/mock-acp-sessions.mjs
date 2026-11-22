// The conversations the Antigravity CLI keeps: a resume finds only a session it saved. With an
// args file or an explicit store the mock keeps them in a file, as a later process sees them;
// with neither (a plain unit run) it resumes any id.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function storePath() {
  if (process.env.CEZ_MOCK_ANTIGRAVITY_SESSIONS_FILE) return process.env.CEZ_MOCK_ANTIGRAVITY_SESSIONS_FILE;
  if (process.env.CEZ_MOCK_ARGS_FILE) return `${process.env.CEZ_MOCK_ARGS_FILE}.antigravity-sessions.json`;
  return undefined;
}
function readStore(path) {
  try { const store = JSON.parse(readFileSync(path, 'utf8')); if (store?.sessions) return store; } catch { /* absent or corrupt */ }
  return { seq: 0, sessions: {} };
}
export function saveSession(id) {
  const path = storePath();
  if (!path) return;
  const store = readStore(path);
  store.sessions[id] = { id };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store));
}
/** The CLI refuses a session it does not hold, such as one the retired registry server saved. */
export function knownSession(id) {
  if (id === 'registry-session') return false;
  const path = storePath();
  if (!path) return true;
  return existsSync(path) && Boolean(readStore(path).sessions[id]);
}
