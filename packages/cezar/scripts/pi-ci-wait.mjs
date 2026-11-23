// Pi 0.87.0 extension API accepts JSON Schema (TypeBox-compatible parameters).
// Resolve beside this installed script; no private workspace dependency or download.
import { existsSync } from 'node:fs';
const source = new URL('../src/ci-wait/client.ts', import.meta.url);
const { registerRemoteSquawkTools } = await import(existsSync(source) ? source.href : new URL('../dist/ci-wait/client.js', import.meta.url).href);
// #781: the shared Squawk tool list, read in Pi's own process, whose env carries the opt-in.
export default registerRemoteSquawkTools;
