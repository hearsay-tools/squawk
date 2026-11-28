import * as React from 'react'
import { ChevronDownIcon } from 'lucide-react'

import { useRunUsage } from '@/api/global-events'
import { Path } from '@/components/data-primitives'
import { DirectionalUsage } from '@/components/directional-usage'
import { TaskPreview } from '@/components/task-status-groups'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { TaskRowModel } from '@/lib/task-model'
import { formatCost, usageCells } from '@/lib/tasks-table'
import { cn } from '@/lib/utils'

/**
 * Explicit per-row telemetry trigger and popover (hearsay-tools/squawk#4377).
 * Replaces the hidden click-on-status-pill telemetry disclosure with a labelled `Usage` control
 * that displays live/peak CPU, memory, tokens IN/OUT, cost, branch, and latest progress.
 */
export function TaskTelemetryPopover({
  model,
  showTokens,
  showCost,
  liveUsageSource = 'stream',
  openLink,
  extraActions,
  className,
}: {
  model: TaskRowModel
  showTokens: boolean
  showCost: boolean
  /** Project Tasks subscribes to live SSE samples when opened; Global Tasks reads index snapshots. */
  liveUsageSource?: 'stream' | 'snapshot'
  openLink: React.ReactNode
  extraActions?: React.ReactNode
  className?: string | undefined
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="task-usage-trigger"
          data-task-control="usage"
          aria-expanded={open}
          aria-label={`Usage and telemetry for ${model.title}`}
          className={cn(
            'inline-flex h-7 max-w-full items-center gap-1 rounded-md border border-border bg-background px-2 font-mono text-[11.5px] text-muted-foreground tabular-nums transition-colors hover:border-control-border hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 max-md:px-2.5',
            open && 'border-accent-strong bg-accent-strong/10 text-foreground',
            className,
          )}
        >
          <span className="min-w-0 truncate">{model.usageSummary}</span>
          <ChevronDownIcon className={cn('size-3 shrink-0 opacity-70 transition-transform motion-reduce:transition-none', open && 'rotate-180')} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      {open ? (
        <PopoverContent
          align="end"
          collisionPadding={8}
          data-slot="task-telemetry-popover"
          className="max-h-(--radix-popover-content-available-height) w-80 max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain p-3.5"
        >
          <TelemetryPopoverBody
            model={model}
            showTokens={showTokens}
            showCost={showCost}
            liveUsageSource={liveUsageSource}
            openLink={openLink}
            extraActions={extraActions}
          />
        </PopoverContent>
      ) : null}
    </Popover>
  )
}

function StreamUsageMetrics({ model, showTokens, showCost }: {
  model: TaskRowModel
  showTokens: boolean
  showCost: boolean
}) {
  const sample = useRunUsage(model.runId)
  return <UsageMetricsGrid model={model} sample={sample} showTokens={showTokens} showCost={showCost} />
}

function UsageMetricsGrid({ model, sample, showTokens, showCost }: {
  model: TaskRowModel
  sample: TaskRowModel['snapshotUsage']
  showTokens: boolean
  showCost: boolean
}) {
  const { run } = model
  const usage = usageCells(run, sample)
  const isLive = usage.cpu.kind === 'live' || usage.mem.kind === 'live'
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold tracking-[0.05em] text-accent-text uppercase">
          Task telemetry
        </span>
        <span className="text-[11px] text-muted-foreground">
          {isLive ? 'Live' : 'Recorded'}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-xs">
        {showTokens ? (
          <div>
            <dt className="text-[11px] text-muted-foreground">Tokens IN / OUT</dt>
            <dd className="mt-0.5 font-mono text-foreground">
              <DirectionalUsage inputTokens={run.inputTokens} outputTokens={run.outputTokens} omitWhenUnknown={false} />
            </dd>
          </div>
        ) : null}
        {showCost ? (
          <div>
            <dt className="text-[11px] text-muted-foreground">Cost</dt>
            <dd className="mt-0.5 font-mono text-foreground tabular-nums">{formatCost(run.costUsd) || '—'}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-[11px] text-muted-foreground">CPU</dt>
          <dd data-usage="cpu" data-usage-kind={usage.cpu.kind} title={usage.cpu.title} className="mt-0.5 font-mono text-foreground tabular-nums">
            {usage.cpu.text || '—'}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-muted-foreground">Memory</dt>
          <dd data-usage="mem" data-usage-kind={usage.mem.kind} title={usage.mem.title} className="mt-0.5 font-mono text-foreground tabular-nums">
            {usage.mem.text || '—'}
          </dd>
        </div>
        {model.branch ? (
          <div className="col-span-2 border-t border-border pt-2">
            <dt className="text-[11px] text-muted-foreground">Branch</dt>
            <dd className="mt-1">
              <Path value={model.branch} variant="chip" />
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  )
}

function TelemetryPopoverBody({ model, showTokens, showCost, liveUsageSource, openLink, extraActions }: {
  model: TaskRowModel
  showTokens: boolean
  showCost: boolean
  liveUsageSource: 'stream' | 'snapshot'
  openLink: React.ReactNode
  extraActions?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3">
      {liveUsageSource === 'stream' ? (
        <StreamUsageMetrics model={model} showTokens={showTokens} showCost={showCost} />
      ) : (
        <UsageMetricsGrid model={model} sample={model.snapshotUsage} showTokens={showTokens} showCost={showCost} />
      )}
      <div className="border-t border-border pt-2.5">
        <TaskPreview
          projectId={model.projectId}
          runId={model.runId}
          status={model.attention.label}
          error={model.run.error}
          open={
            <div className="flex flex-wrap items-center gap-2">
              {openLink}
              {extraActions}
            </div>
          }
        />
      </div>
    </div>
  )
}

export function TelemetryOpenButton({ children }: { children: React.ReactNode }) {
  return (
    <Button asChild variant="outline" size="sm" className="max-md:min-h-11">
      {children}
    </Button>
  )
}
