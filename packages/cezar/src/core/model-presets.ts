import { backendModelMap, parseModelIdentity } from './model-identity.ts';
import { isRegisteredRunner, registeredRunners, runnerDefinition } from './runner-registry.ts';

/**
 * The vendor prefixes this module treats as evidence of a mis-paired model. Deliberately local
 * rather than an export of `model-identity.ts` (#548/#831): nothing else may gate on it, because
 * `resolveModelIdentity` lets an unknown provider through on purpose. It is a heuristic for
 * {@link namesAnotherKnownProvider} alone, and being short is a feature — every entry costs a
 * false refusal if Squawk is ever wrong about who serves it.
 */
const KNOWN_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter'] as const;

/**
 * The runner's known picker presets: its definition's `models.known`, mirrored for mismatch
 * checks. An id that no runner registered has none.
 */
function knownPresets(runner: string): readonly string[] | undefined {
  return isRegisteredRunner(runner) ? runnerDefinition(runner).models.known : undefined;
}

/**
 * True when the `provider/` prefix on `model` names a provider Squawk knows that this
 * single-provider runner does not serve — `anthropic/…` handed to codex.
 *
 * Deliberately narrower than the run-time gate in `model-identity.ts`: this check is
 * synchronous and therefore cannot read the runner's `configuredProvider`, so an UNFAMILIAR
 * prefix (`my-org/custom-tune`) is left alone — it may well be the user's own gateway, which
 * the run-time gate accepts once it has read the config. Only a prefix naming another known
 * vendor is evidence enough to refuse the pairing up front.
 */
function namesAnotherKnownProvider(model: string, runner: string): boolean {
  const map = backendModelMap(runner);
  // Nothing to contradict: OpenCode spans providers (no default of its own), and Claude Code
  // accepts explicit gateway/custom provider ids by design.
  if (map?.defaultProvider === undefined || map.allowExplicitProvider) return false;
  const explicit = parseModelIdentity(model);
  if (!explicit || explicit.provider === map.defaultProvider) return false;
  return (KNOWN_PROVIDERS as readonly string[]).includes(explicit.provider);
}

/** True when `model` is recognizably a preset of a runner OTHER than `runner` (and not also one
 *  of `runner`'s own presets), or when its provider prefix is one this runner is known not to
 *  serve. `''`/unknown/custom ids never conflict. A native-ID namespace owns every opaque
 *  id it exposes, including IDs another runner also lists. */
export function modelConflictsWithRunner(model: string, runner: string): boolean {
  if (!model || backendModelMap(runner)?.nativeIdNamespace) return false;
  if (knownPresets(runner)?.includes(model)) return false;
  // The provider half of the guard needs no vendor model knowledge, so — unlike the preset
  // lists — it keeps holding for models that do not exist yet. That is what lets OpenCode's
  // `models.known` be empty (#794) without losing the protection it used to provide.
  if (namesAnotherKnownProvider(model, runner)) return true;
  return registeredRunners().some(
    (other) => other.id !== runner && other.models.known.includes(model),
  );
}
