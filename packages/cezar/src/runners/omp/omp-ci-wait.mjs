// OMP (Oh My Pi) extension: registers Squawk's tools in OMP's own process (#595). Same shape as
// pi-ci-wait.mjs; OMP's `pi.registerTool` takes the JSON Schema `parameters` as Pi does.
// Resolve the tool client from the session environment; no path relative to this script.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// oxlint-disable-next-line cez/product-env-read -- Runs in OMP's own process without Squawk's module resolver; HSQ_TOOL_CLIENT is the bootstrap URL.
const rawUrl = process.env.HSQ_TOOL_CLIENT ?? process.env.CEZ_TOOL_CLIENT;
if (!rawUrl) {
  throw new Error('HSQ_TOOL_CLIENT is not set; Squawk must provide the tool client URL in the session environment.');
}
const clientUrl = new URL(rawUrl);
const builtUrl = new URL('../../dist/ci-wait/client.js', clientUrl);
// Unlike Pi's loader, OMP's cannot resolve the workspace contract package from a source checkout
// (v18.4.11), so a failed source import falls back to the built output, but only when it exists:
// otherwise the source error is the real cause and is rethrown, not hidden behind a missing dist.
const loadBuilt = (error) => {
  if (builtUrl.href === clientUrl.href || builtUrl.protocol !== 'file:' || !existsSync(fileURLToPath(builtUrl))) throw error;
  process.stderr.write('Squawk: loading built Squawk tools from dist/; rebuild after changing src/ci-wait\n');
  return import(builtUrl.href);
};
const { registerRemoteSquawkTools } = await (
  clientUrl.pathname.endsWith('.ts') ? import(clientUrl.href).catch(loadBuilt) : import(clientUrl.href)
);
// #781: the shared Squawk tool list, read in OMP's own process, whose env carries the opt-in.
// `ompTools` admits exactly these names to `--tools`: OMP exits 2 on a name nothing registered.
export default registerRemoteSquawkTools;
