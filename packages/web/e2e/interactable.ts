/** The page expressions `click` and `fill` wait on before they act (hearsay-tools/squawk#3820). */

/** Options for `click` and `fill`. `allowDisabled` skips only the enabled check, for a spec
 *  that acts on a disabled control on purpose. */
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

/** The `wait --fn` predicate of `click` and `fill`. False while the target is missing or, unless
 *  `allowDisabled`, disabled. Once it can act, it scrolls a target that is not fully inside the
 *  viewport to the centre, and leaves a fully visible target where it is, so a spec that
 *  measures scroll positions keeps its numbers. */
export function interactableExpression(selector: string, options: InteractOptions = {}): string {
  return `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return false;
    if (${!options.allowDisabled} && (${DISABLED_STATE}) !== null) return false;
    const box = target.getBoundingClientRect();
    if (box.top < 0 || box.left < 0 || box.bottom > innerHeight || box.right > innerWidth) {
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }
    return true;
  })()`
}

/** Names why `interactableExpression` stayed false, for the failure message. */
export function disabledStateExpression(selector: string): string {
  return `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return 'detached';
    return (${DISABLED_STATE}) ?? 'unknown';
  })()`
}
