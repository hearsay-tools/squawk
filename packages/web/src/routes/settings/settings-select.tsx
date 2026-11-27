import type { SelectHTMLAttributes } from 'react'
import { ChevronDownIcon } from '@/components/design-icons'
import { cn } from '@/lib/utils'

/**
 * A native `<select>` with a visible trailing chevron, so no Settings dropdown reads as a
 * static text box. `className` styles the select itself; the wrapper only positions the icon.
 *
 * The wrapper shrink-wraps the select (`w-fit`): a flex or grid parent would otherwise stretch
 * it to the full row while the select keeps its own width, and the chevron would float at the
 * far edge of the row instead of sitting inside the control's border. A caller that wants a
 * full-width select sizes the wrapper through `.settings-select` in `settings-interiors.css`.
 */
export function SettingsSelect({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span data-slot="settings-select" className="settings-select relative inline-block w-fit min-w-0 max-w-full align-middle">
      <select {...props} className={cn('appearance-none pr-8 max-w-full', className)}>
        {children}
      </select>
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  )
}
