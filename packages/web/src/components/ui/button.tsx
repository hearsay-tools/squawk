import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/* Variant vocabulary comes from the Squawk masters, not stock shadcn:
 * `primary` (gold) and `contrast` (inverse surface) are the two CTAs, `danger-ghost` is the
 * destructive affordance. There is deliberately no `secondary`/`link` — the design system doesn't use them.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-[7px] rounded-md font-semibold whitespace-nowrap transition-[background-color,border-color,opacity,filter] outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50 enabled:active:brightness-90 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Gold means "ready to trigger". A disabled primary drops to a neutral bordered surface,
        // so it never reads as a muddy tint; full opacity keeps its label readable in both themes.
        primary: "bg-action text-action-foreground pointer-hover:brightness-[0.96] disabled:border disabled:border-border disabled:bg-muted/80 disabled:text-muted-foreground disabled:opacity-100",
        contrast: "bg-contrast text-contrast-foreground pointer-hover:brightness-[0.96]",
        outline: "border border-border bg-card text-foreground pointer-hover:bg-muted",
        ghost: "text-muted-foreground pointer-hover:bg-muted pointer-hover:text-foreground",
        "danger-ghost": "text-danger pointer-hover:bg-danger/10",
      },
      size: {
        default: "h-11 px-3.5 text-[13px]",
        sm: "h-[30px] rounded-sm px-2.5 text-[13px]",
        // Icon sizes still set the label size: a labelled icon button (the composer's Continue)
        // must match its text siblings instead of inheriting the larger body size.
        icon: "size-9 text-[13px]",
        "icon-sm": "size-[30px] rounded-sm text-[13px]",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "primary",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
