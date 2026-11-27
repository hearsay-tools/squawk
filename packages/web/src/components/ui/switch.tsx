"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/** The track and thumb colours of every toggle, keyed on `data-state`. New Task's ToggleTrack
 *  (routes/new-task-sections.tsx) sets the same `data-state` and reuses these strings, so both
 *  surfaces draw one knob. On is a crisp white knob on the accent fill in both themes. Off is a
 *  muted light knob on the dark theme, and a white knob with a hairline and a soft shadow on a
 *  pale track on the light one, so it never reads heavier than the on state. */
export const SWITCH_TRACK_COLORS =
  "data-[state=checked]:border-accent-strong data-[state=checked]:bg-accent-strong data-[state=unchecked]:border-muted-foreground/60 data-[state=unchecked]:bg-muted [.light_&]:data-[state=unchecked]:border-muted-foreground/35"
export const SWITCH_THUMB_COLORS =
  "data-[state=checked]:bg-white data-[state=unchecked]:bg-foreground/80 [.light_&]:data-[state=unchecked]:border [.light_&]:data-[state=unchecked]:border-muted-foreground/30 [.light_&]:data-[state=unchecked]:bg-card [.light_&]:data-[state=unchecked]:shadow-sm"

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
        "peer group/switch inline-flex shrink-0 items-center rounded-full border shadow-none transition-[color,background-color,border-color,box-shadow] outline-hidden focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-6 data-[size=default]:w-10 data-[size=sm]:h-3.5 data-[size=sm]:w-6",
        SWITCH_TRACK_COLORS,
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          SWITCH_THUMB_COLORS,
          "pointer-events-none block rounded-full ring-0 motion-safe:transition-transform group-data-[size=default]/switch:size-[18px] group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-[state=checked]:translate-x-5 group-data-[size=default]/switch:data-[state=unchecked]:translate-x-0.5 group-data-[size=sm]/switch:data-[state=checked]:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
