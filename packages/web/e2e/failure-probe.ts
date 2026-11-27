/** The page expressions the seam's failure bundle evaluates. Each only reads the page. */

export type FailureReason =
  | { kind: 'wait-selector'; action: 'click' | 'hover' | 'fill'; selector: string }
  | { kind: 'wait-fn'; predicate: string }
  | { kind: 'wait-enabled'; action: 'click' | 'fill' | 'hover'; selector: string; state: string }
  | { kind: 'wait-value'; expression: string; lastValue: unknown; lastError?: string }
  | { kind: 'test' }

/**
 * The in-page probe. Built as one expression so a single `eval` fetches everything, and
 * every branch is wrapped so a selector the CSS engine rejects (agent-browser also accepts
 * `text=` and `@ref`) records the rejection instead of failing the probe.
 *
 * A timed-out predicate is recorded in `probe.json`, never re-run here: specs put side effects
 * in predicates (`thread-scroll.e2e.ts` clicks a button inside one), and a capture that fired
 * them again would alter the session the spec's remaining tests share. The probe only reads.
 */
export function probeScript(reason: FailureReason): string {
  const selector = reason.kind === 'wait-selector' || reason.kind === 'wait-enabled' ? JSON.stringify(reason.selector) : 'null'
  return `(() => {
    const path = (el) => {
      const parts = []
      for (let node = el; node && node.nodeType === 1 && parts.length < 12; node = node.parentElement) {
        let part = node.tagName.toLowerCase()
        if (node.id) part += '#' + node.id
        else {
          const cls = [...node.classList].slice(0, 3).join('.')
          if (cls) part += '.' + cls
          const parent = node.parentElement
          if (parent) {
            const siblings = [...parent.children].filter((c) => c.tagName === node.tagName)
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
          }
        }
        parts.unshift(part)
      }
      return parts.join(' > ')
    }
    const describe = (el) => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const under = document.elementFromPoint(cx, cy)
      return {
        path: path(el),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        inViewport: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
        style: {
          display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
          pointerEvents: cs.pointerEvents, position: cs.position, zIndex: cs.zIndex,
          transform: cs.transform, transition: cs.transition,
        },
        attributes: Object.fromEntries([...el.attributes].slice(0, 12).map((a) => [a.name, a.value.slice(0, 120)])),
        text: (el.textContent || '').trim().slice(0, 120),
        elementUnderCentre: under
          ? { path: path(under), coversTarget: under !== el && !el.contains(under) }
          : null,
      }
    }
    const out = {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
      activeElement: document.activeElement && document.activeElement !== document.body
        ? describe(document.activeElement)
        : null,
      openDialogs: [...document.querySelectorAll('[role="dialog"], dialog[open]')].map(path),
    }
    const selector = ${selector}
    if (selector !== null) {
      try {
        const nodes = [...document.querySelectorAll(selector)]
        out.target = { count: nodes.length, matches: nodes.slice(0, 5).map(describe) }
      } catch (error) {
        out.target = { count: null, selectorError: String(error) }
      }
    }
    return out
  })()`
}

/** Read-only geometry, sampled when the test asks, never by re-running its assertion. */
export function layoutScript(selectors: Record<string, string>): string {
  return `(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const path = (el) => {
      const parts = [];
      for (let node = el; node && parts.length < 12; node = node.parentElement) {
        parts.unshift(node.tagName.toLowerCase() + (node.id ? '#' + node.id : ''));
        if (node.id) break;
      }
      return parts.join(' > ');
    };
    const clippingAncestor = (el) => {
      for (let node = el.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        const axes = [];
        if (/^(hidden|clip|scroll|auto)$/.test(style.overflowX)) axes.push('x');
        if (/^(hidden|clip|scroll|auto)$/.test(style.overflowY)) axes.push('y');
        if (axes.length) return { path: path(node), axes, rect: rect(node) };
      }
      return null;
    };
    const selectors = {};
    for (const [name, selector] of Object.entries(${JSON.stringify(selectors)})) {
      try {
        const nodes = [...document.querySelectorAll(selector)];
        selectors[name] = { selector, count: nodes.length, matches: nodes.map(el => ({
          path: path(el), rect: rect(el),
          scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
          scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
          clippingAncestor: clippingAncestor(el),
        })) };
      } catch (error) { selectors[name] = { selector, error: String(error) }; }
    }
    return { url: location.href, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY }, selectors };
  })()`
}
