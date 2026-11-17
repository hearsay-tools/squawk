Refs hearsay-tools/squawk#3816

Combine repeated browser setup with the stronger scenario that already exercises the same state. Keep all assertions, screenshots and platform boundaries.

## Removed
- Command palette: repeated navigation already performed by beforeEach.

## Merged
- Diff flat baseline → force-virtual viewport comparison.
- Thread flat baseline → auto-mode DOM comparison.
- Commit API count → bounded browser DOM scenario.
- Empty-state decorative backdrop → no-tasks navigation.
- Missing-page message → return-to-overview navigation.
- Composer waiting, slash menu, completion, send and follow-up → one skill reply round trip.

## Repaired
None. Existing fresh-run setup already removed the older test-order dependency.

## Proof
Pending focused mutation evidence.

## Remaining coverage
Complete source counts precede virtualization comparisons. Composer completion reaches persisted/live reply delivery. Empty states retain accessibility, screenshots and working navigation. Dictation, phone layouts, scroll restoration and commit diff navigation stay separate.

## Verification
Pending local gate and focused Squeal browser result. CI owns the full suite.

## Left undone
Other audit slices and existing scroll/action retry repairs are separate. No production or browser helper changes.
