"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        // Off is an outlined, muted track; on is the accent fill. Each state sets its own thumb
        // colour, so the thumb contrasts with its track in both themes.
        "peer group/switch inline-flex shrink-0 items-center rounded-full border shadow-none transition-[color,background-color,border-color,box-shadow] outline-hidden focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-6 data-[size=default]:w-10 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-[state=checked]:border-accent-strong data-[state=checked]:bg-accent-strong data-[state=unchecked]:border-muted-foreground/60 data-[state=unchecked]:bg-muted",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full ring-0 data-[state=checked]:bg-accent-strong-foreground data-[state=unchecked]:bg-foreground/95 motion-safe:transition-transform group-data-[size=default]/switch:size-[18px] group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-[state=checked]:translate-x-5 group-data-[size=default]/switch:data-[state=unchecked]:translate-x-0.5 group-data-[size=sm]/switch:data-[state=checked]:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
