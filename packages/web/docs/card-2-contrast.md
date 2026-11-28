# Small text on card-2 and contrast tokens

Use at least **4.5:1** contrast for text under 24 px regular (or 18.67 px bold) on every
cockpit surface, including `bg-card-2` (`--surface-muted`) and selected sidebar rows
(`--sidebar-row-selected`). All cockpit text uses a `>= 12 px` (`text-xs`) floor.

These ratios come from the closed four-role text scale and dedicated small-size semantic text
tokens in `src/styles/index.css` (hearsay-tools/squawk#4379). Automated CI checks in
`packages/web/src/styles/token-contrast.test.ts` compute exact OKLCH → sRGB contrast ratios for
every pair in both dark and light themes.

| Foreground utility | Dark (`card-2`) | Light (`card-2`) | Safe in both themes? |
| --- | ---: | ---: | --- |
| `text-foreground` (`--text-primary`) | 10.12:1 | 15.05:1 | Yes — primary text |
| `text-muted-foreground`, `text-supporting-foreground` (`--text-secondary`) | 6.13:1 | 6.84:1 | Yes — secondary text |
| `text-soft-foreground` (`--text-muted`) | 5.10:1 | 5.40:1 | Yes — muted text (lifted in hearsay-tools/squawk#4379) |
| `text-link-foreground` (`--accent-text`) | 7.60:1 | 4.93:1 | Yes — links |
| `text-semantic-red`, `text-signal-word-red` | 5.30:1 | 5.47:1 | Yes — small red semantic text & diff deletions |
| `text-semantic-amber`, `text-signal-word-amber`, `text-pending-strong` | 8.39:1 | 5.83:1 | Yes — small amber semantic text |
| `text-semantic-violet` | 5.43:1 | 5.98:1 | Yes — small violet semantic text |
| `text-semantic-green`, `text-success` | 7.63:1 | 5.22:1 | Yes — small green semantic text & diff additions |
| `text-semantic-info`, `text-info` | 6.77:1 | 5.32:1 | Yes — review & info text |
| `text-semantic-conflict`, `text-conflict` | 7.28:1 | 4.97:1 | Yes — merge conflict text |
| `text-danger`, `text-destructive` (fill token) | 4.34:1 | 4.10:1 | No — use `text-semantic-red` or `text-signal-word-red` |
| `text-disabled-foreground` (`--text-disabled`) | 2.93:1 | 3.33:1 | Inactive controls only (WCAG 1.4.3 exempt) |

Icons and non-text graphics have a separate 3:1 requirement; these text rules
do not prohibit their use of fill tokens such as `danger`.

## Reproduction and guard

Reproduced for hearsay-tools/cezarion#1133 at `3040cbf78`:
open `src/routes/task-thread/thread-items.tsx`, find `data-slot="tool-error"`,
and follow its parent `bg-card-2`. The body then used `text-xs text-danger`.
`packages/web/src/styles/token-contrast.test.ts` validates the token table directly from
`src/styles/index.css` in CI on every PR. For rendered measurements, use
`e2e/contrast.ts`'s `contrastSampleExpression` on the element.

All pre-existing `packages/web/src/test/card-2-contrast.baseline.json` entries were resolved in
hearsay-tools/squawk#4379; the baseline is empty (`[]`).

`cez/card-2-contrast` in `npm run lint` scans JSX class strings, including literal
branches of class helpers and templates. It follows card-2 ancestors, inherited
ink, font sizes and named font weights, and known tool/hook body slots. A named opaque palette background ends inheritance; transparent/translucent
backgrounds, images, and background layout utilities retain it conservatively. Literal size/background branches are checked
conservatively, including empty/absent class branches. Expansion is capped at 128
combinations with a conservative fallback. JSX-only expressions are visited as elements rather than wrapper text. Unknown font sizes are treated conservatively as
small. Known pixel/Tailwind sizes qualify as large at 24 px regular or 18.67 px
with bold, extrabold or black weight; unknown weights grant no bold exemption.
Important modifiers, fully opaque background suffixes (`/100`, `/[1]`, `/[100%]`),
and opacity suffixes on unsafe ink are normalized; reducing
these colors’ opacity cannot grant a contrast exemption. Variant-prefixed ink, size, weight and card-2 utilities are checked as possible
states alongside the default state; variant backgrounds cannot grant an opaque-surface exemption. Icons without text and explicitly large text are excluded.

This is a static guard, not a computed-style audit: runtime-generated classes,
component boundaries and CSS rules still need rendered contrast checks.
The lint rule rejects new instances; the lint runner rejects stale baseline entries.
`../cezar/src/lint/card-2-contrast.test.ts` keeps the inline scanner fixtures without a repository scan.
