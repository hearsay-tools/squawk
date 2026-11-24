/**
 * HTTP content negotiation for the two routes that serve more than one FORMAT on one path:
 * `GET /repo/commit/:sha` (a structured payload or the legacy text blob) and
 * `GET /runs/:id/files` (a JSON listing/metadata or an image file's BYTES).
 *
 * ## Precedence — flag, then Accept, then the route's own default
 *
 * 1. **The query flag wins whenever the request carries it.** `?structured=1` and `?raw=1` are the
 *    live wire; `Accept` is ADDITIVE and
 *    may never override a caller that said what it wanted in the URL. The flag counts as "carried"
 *    when the key is PRESENT, so `?raw=0` is an explicit opt-out of the raw representation and not
 *    an invitation to re-decide from a header.
 * 2. **Otherwise the best `Accept` match** among the representations that route offers.
 * 3. **Otherwise the route's established default** — the text blob for `/repo/commit/:sha`, the
 *    JSON listing for `/runs/:id/files` — i.e. exactly what a pre-Accept client received.
 *
 * `*<slash>*` matches NOTHING here, deliberately: it is what `fetch`, `curl` and XHR send when
 * they have no preference at all, and treating "anything" as a preference would silently change
 * the default representation of both routes for every existing caller. A browser that navigates to
 * a worktree image DOES get the bytes, because its `Accept` really does ask for `image/*` at q=1 —
 * the same protections ride along (image extensions only, size cap, `nosniff`, sandbox CSP).
 *
 * Both routes answer `Vary: Accept`, since a cache that ignored the header would serve one
 * representation for the other.
 */
type MediaRange = { type: string; subtype: string; q: number };

function parseAccept(header: string): MediaRange[] {
  const ranges: MediaRange[] = [];
  for (const part of header.split(',')) {
    const [range = '', ...params] = part.split(';');
    const [type = '', subtype = ''] = range.trim().toLowerCase().split('/');
    if (type === '' || subtype === '') continue;
    const weight = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith('q='));
    const parsed = weight === undefined ? 1 : Number.parseFloat(weight.slice(2));
    const q = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
    if (q > 0) ranges.push({ type, subtype, q });
  }
  return ranges;
}

/**
 * The best of `offers` for this `Accept`, or `null` for "no preference expressed" — which is what
 * an absent header, a `*<slash>*`-only header and a header naming nothing on offer all mean, and
 * what leaves the caller on its route's default.
 *
 * `offers` is the server's own preference order: an offer may itself be a wildcard (`image/*`,
 * since the concrete image type is not known until the file is read), and equal q-values go to the
 * EARLIER offer, so each route lists its default representation first.
 */
export function negotiate<O extends string>(accept: string | undefined, offers: readonly O[]): O | null {
  if (accept === undefined) return null;
  const ranges = parseAccept(accept);
  let best: { offer: O; q: number } | null = null;
  for (const offer of offers) {
    const [type = '', subtype = ''] = offer.split('/');
    let q = 0;
    for (const range of ranges) {
      if (range.type === '*' && range.subtype === '*') continue; // "anything" is not a preference
      const typeMatches = range.type === type || range.type === '*' || type === '*';
      const subtypeMatches = range.subtype === subtype || range.subtype === '*' || subtype === '*';
      if (typeMatches && subtypeMatches && range.q > q) q = range.q;
    }
    if (q > 0 && (best === null || q > best.q)) best = { offer, q };
  }
  return best?.offer ?? null;
}
