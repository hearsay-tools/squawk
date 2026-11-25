// Pi 0.87.0 extension API accepts JSON Schema (TypeBox-compatible parameters).
// Resolve the tool client from the session environment; no path relative to this script.
// oxlint-disable-next-line cez/product-env-read -- Runs in Pi's own process without Squawk's module resolver; HSQ_TOOL_CLIENT is the bootstrap URL.
const rawUrl = process.env.HSQ_TOOL_CLIENT ?? process.env.CEZ_TOOL_CLIENT;
if (!rawUrl) {
  throw new Error('HSQ_TOOL_CLIENT is not set; Squawk must provide the tool client URL in the session environment.');
}
const { registerRemoteSquawkTools } = await import(new URL(rawUrl).href);
// #781: the shared Squawk tool list, read in Pi's own process, whose env carries the opt-in.
export default registerRemoteSquawkTools;
