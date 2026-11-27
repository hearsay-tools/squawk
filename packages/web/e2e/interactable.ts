/** The page expressions `click`, `fill` and `hover` wait on before they act (hearsay-tools/squawk#3820). */

/** Options for `click` and `fill`. `allowDisabled` skips only the enabled check, for a spec
 *  that acts on a disabled control on purpose. `hover` always passes it. */
export interface InteractOptions {
  allowDisabled?: boolean
}

/** Provider snapshot refs (`@e2`) and XPath (`//button`) are not CSS selectors. */
export function isCssSelector(selector: string): boolean {
  return !selector.startsWith('@') && !selector.startsWith('/')
}

/** The disabled state `click` and `fill` wait out: the target matches `:disabled` (a disabled
 *  `<fieldset>` ancestor included), or the target itself has `aria-disabled="true"`. */
const DISABLED_STATE = `target.matches(':disabled') ? 'disabled'
      : target.getAttribute('aria-disabled') === 'true' ? 'aria-disabled="true"' : null`

/** What sits on the target's centre point, where agent-browser presses or hovers, when that is
 *  not the target: null when the hit is the target, a part of it, an ancestor of it, or its
 *  label. A point outside the viewport hits nothing, and the viewport check owns that case.
 *  A box inside the window can still be clipped by its scroller: on a phone, content scrolled
 *  above the main scroller sits under the shell's top bar, and the docked Session tabs cover
 *  the rows that scroll under them. */
const COVERED_STATE = `(() => {
      const box = target.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (!hit || hit === target || target.contains(hit) || hit.contains(target) || hit.control === target) return null;
      const slot = hit.getAttribute('data-slot');
      return 'covered by <' + hit.tagName.toLowerCase() + (slot ? ' data-slot="' + slot + '"' : '') + '>';
    })()`

/** The `wait --fn` predicate of `click`, `fill` and `hover`. False while the target is missing,
 *  unless `allowDisabled` disabled, or, for a pointer action, covered at its centre point. It
 *  scrolls a target that is not fully inside the viewport, or is covered, to the centre, and
 *  leaves a fully visible target where it is, so a spec that measures scroll positions keeps its
 *  numbers. A docked header can stay over its own child for several scrolls, so each poll
 *  scrolls again until it is clear. `fill` types without a pointer, so it skips the hit test. */
export function interactableExpression(selector: string, options: InteractOptions = {}, pointer = true): string {
  const covered = pointer ? COVERED_STATE : 'null'
  return `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return false;
    if (${!options.allowDisabled} && (${DISABLED_STATE}) !== null) return false;
    const box = target.getBoundingClientRect();
    if (box.top < 0 || box.left < 0 || box.bottom > innerHeight || box.right > innerWidth || (${covered}) !== null) {
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }
    return (${covered}) === null;
  })()`
}

/** Names why `interactableExpression` stayed false, for the failure message. */
export function blockedStateExpression(selector: string): string {
  return `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return 'detached';
    return (${DISABLED_STATE}) ?? (${COVERED_STATE}) ?? 'unknown';
  })()`
}
