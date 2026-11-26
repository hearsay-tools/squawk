/** Tarball bundle check — the pure half of `scripts/check-pack.mjs`.
 *
 *  Phase R1 of the cockpit redesign shipped an npm tarball with no UI in it
 *  (`files` listed the sources, not the Vite build). This module pins that bug
 *  class: given the file list `npm pack --dry-run --json` reports, decide
 *  whether the package would ship a working cockpit. Kept dependency-free and
 *  side-effect-free so the decision is unit-testable; the script owns the
 *  `npm pack` invocation and the exit code.
 */

/** The plugin entry and the runner kit subpaths `package.json` exports
 *  (spec 2026-11-24-plugin-loader-and-runner-kit § 2 and § 3). A host plugin imports them. */
export const PLUGIN_ENTRY_FILES: readonly string[] = [
  'dist/plugin/index.js',
  'dist/plugin/runtime.js',
  'dist/plugin/model-settings.js',
  'dist/plugin/managed-cli.js',
  'dist/plugin/pi-rpc.js',
];

/** Human-readable problems with a would-be tarball; empty array = publishable.
 *
 *  Requirements (spec `.ai/specs/2026-07-14-cockpit-ui-redesign.md`, Serving):
 *  - `web/dist/index.html` — the built shell every GET serves.
 *  - at least one `web/dist/assets/*` file — the hashed JS/CSS bundles; an
 *    index.html alone renders a blank page.
 *  And (spec 2026-11-24-plugin-loader-and-runner-kit § 5):
 *  - every file of `PLUGIN_ENTRY_FILES`;
 *  - `dist/runners/<id>/index.js` for each id of `bundledRunnerIds`: boot loads each bundled
 *    runner from that entry, so a runner without one is missing from the cockpit.
 *  And (spec 2026-11-25-self-contained-runner-folders, Decision 3):
 *  - every copied runner `.mjs` asset in `runnerAssetFiles` (`dist/runners/<id>/...`).
 *  And (spec 2026-11-26-launch-slot-and-bundled-jobs § 4):
 *  - `dist/features/<id>/index.js` for each id of `bundledFeatureIds`: boot loads each bundled
 *    feature from that entry, so a feature without one is missing from the product.
 */
export function findPackGaps(
  packedFiles: readonly string[],
  bundledRunnerIds: readonly string[],
  runnerAssetFiles: readonly string[] = [],
  bundledFeatureIds: readonly string[] = [],
): string[] {
  const gaps: string[] = [];
  if (!packedFiles.includes('web/dist/index.html')) {
    gaps.push('web/dist/index.html is missing — the tarball would ship no UI shell (run `npm run build:web`)');
  }
  if (!packedFiles.some((f) => f.startsWith('web/dist/assets/') && f.length > 'web/dist/assets/'.length)) {
    gaps.push('no web/dist/assets/* bundle in the tarball — the shell would load with no JS/CSS');
  }
  for (const file of PLUGIN_ENTRY_FILES) {
    if (!packedFiles.includes(file)) gaps.push(`${file} is missing — a plugin could not import Squawk's plugin API (run \`npm run build\`)`);
  }
  if (bundledRunnerIds.length === 0) gaps.push('no bundled runner was found — the cockpit would have no runner');
  for (const id of bundledRunnerIds) {
    const entry = `dist/runners/${id}/index.js`;
    if (!packedFiles.includes(entry)) gaps.push(`${entry} is missing — boot would not load the ${id} runner (run \`npm run build\`)`);
  }
  for (const asset of runnerAssetFiles) {
    if (!packedFiles.includes(asset)) gaps.push(`${asset} is missing — runner asset was not copied into dist/ (run \`npm run build\`)`);
  }
  for (const id of bundledFeatureIds) {
    const entry = `dist/features/${id}/index.js`;
    if (!packedFiles.includes(entry)) gaps.push(`${entry} is missing — boot would not load the ${id} feature (run \`npm run build\`)`);
  }
  return gaps;
}
