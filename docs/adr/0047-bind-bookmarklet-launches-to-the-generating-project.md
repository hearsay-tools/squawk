# Bind bookmarklet launches to the generating project

**Retired.** Bookmarklet launches are removed (hearsay-tools/squawk#3578): the Settings →
Bookmarklets section, the generator, the per-project launch key and `GET /api/v1/launch-key`
are gone. `/new?skill=&ref=` still prefills the composer, and `auto` and `key` are ignored, so
a saved bookmarklet only prefills. This record describes the removed policy, not a current
capability.

A generated bookmarklet navigates directly to the cockpit origin and project that created
it. It does not fetch a range of localhost ports from the source page. A per-project launch
key authorizes automatic start; without the key the deep link only prefills the composer.

## Consequences

Saved links retain the protected skill/auto/key/ref query grammar. New scoped paths carry
the selected project’s key; flat paths retain boot-project resolution. The launch key is an
auto-start capability, not general API authentication.

Historical context: the original comment records that GitHub’s page policy blocked the old
localhost discovery fetch in July 2026. The implemented direct navigation avoids that dependency;
it does not promise a particular current GitHub CSP. A launcher stays tied to its saved origin,
so moving the cockpit can require generating another launcher.

Commit `6100c12608aa20e8ba3c9c7da9eeb5f473131276` records that replacement and its original
CSP observation.

## Considered Options

- **Probe localhost ports from the source page.** Replaced because the recorded browser policy prevented discovery and could select another cockpit.

Implementation and coverage were removed with the feature; commit `6100c12608aa20e8ba3c9c7da9eeb5f473131276` and the history of `packages/web/src/lib/bookmarklet.ts` hold them.
