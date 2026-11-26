import type { SessionContextPreview, SessionContextPreviewBlock, SessionContextRole } from '@open-mercato/cezar-api-client'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const TARGET_LABEL: Record<NonNullable<SessionContextPreviewBlock['target']>, string> = {
  'built-in': 'built in',
  parent: 'parent',
  worker: 'worker',
  both: 'both',
}

const STATUS_CLASS: Record<SessionContextPreviewBlock['status'], string> = {
  applied: 'border-success/40 text-success',
  skipped: 'border-conflict/50 text-conflict',
  'not-for-role': 'text-soft-foreground',
}

const bytes = (n: number) => `${n.toLocaleString('en-US')} B`

/**
 * The right half of Settings → Session context: what a session would receive from the draft,
 * block by block, and how much of the 64 KiB limit it uses.
 */
export function SessionContextPreviewPanel({
  preview,
  role,
  onRole,
  pending,
  className,
}: {
  preview: SessionContextPreview | undefined
  role: SessionContextRole
  onRole: (role: SessionContextRole) => void
  pending: boolean
  className?: string | undefined
}) {
  return (
    <section
      data-slot="session-context-preview"
      aria-labelledby="session-context-preview-title"
      aria-busy={pending}
      className={cn('flex flex-col overflow-hidden rounded-lg border border-border bg-card', className)}
    >
      <div className="flex flex-col gap-3 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <h3 id="session-context-preview-title" className="text-sm font-semibold">Preview</h3>
          <span className="ml-auto text-[12px] text-soft-foreground">Updates as you type</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span id="session-context-role" className="text-[12px] text-soft-foreground">Preview as</span>
          <div role="radiogroup" aria-labelledby="session-context-role" className="inline-flex overflow-hidden rounded-md border border-[var(--control-border)]">
            {(['parent', 'worker'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={role === value}
                data-slot="session-context-role"
                onClick={() => onRole(value)}
                className={cn(
                  'min-h-11 px-4 text-[13px] capitalize text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring',
                  role === value && 'bg-muted text-foreground',
                )}
              >
                {value}
              </button>
            ))}
          </div>
          <span className="text-[12px] text-soft-foreground">Files come from the project checkout. Task values are samples.</span>
        </div>
        {preview ? <ByteMeter used={preview.usedBytes} limit={preview.limitBytes} blocks={preview.blocks} /> : <div className="h-[38px]" />}
      </div>
      <ul data-slot="session-context-blocks" className="divide-y divide-border">
        {preview?.blocks.map((block, index) => <PreviewBlock key={`${block.id}-${index}`} block={block} role={role} />)}
      </ul>
    </section>
  )
}

function ByteMeter({ used, limit, blocks }: { used: number; limit: number; blocks: SessionContextPreviewBlock[] }) {
  const applied = blocks.filter((b) => b.status === 'applied').length
  const skipped = blocks.filter((b) => b.status === 'skipped').length
  const percent = Math.min(100, (used / limit) * 100)
  return (
    <div data-slot="session-context-meter">
      <div
        role="meter"
        aria-label="Session context size"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        aria-valuetext={`${bytes(used)} of ${bytes(limit)}`}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-accent-strong" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 text-[12px]">
        <span className="text-muted-foreground">
          {bytes(used)} used: {applied} {applied === 1 ? 'block' : 'blocks'} applied{skipped > 0 ? `, ${skipped} skipped` : ''}
        </span>
        <span className="ml-auto text-soft-foreground">Limit 64 KiB ({bytes(limit)})</span>
      </div>
    </div>
  )
}

function PreviewBlock({ block, role }: { block: SessionContextPreviewBlock; role: SessionContextRole }) {
  const status = block.status === 'not-for-role' ? `not for ${role}` : block.status
  return (
    <li data-slot="session-context-block" data-status={block.status} className="flex flex-col gap-1.5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-[12px] text-foreground">{block.id}</code>
        {block.target && <Badge variant="outline" className="text-[11px]">{TARGET_LABEL[block.target]}</Badge>}
        <span className="ml-auto font-mono text-[12px] text-soft-foreground">{block.bytes === null ? '—' : bytes(block.bytes)}</span>
        <Badge variant="outline" className={cn('text-[11px]', STATUS_CLASS[block.status])}>{status}</Badge>
      </div>
      {block.reason && <p className="text-[12px] text-conflict">{block.reason}</p>}
      {block.text !== null && (
        <pre className="max-h-28 overflow-hidden rounded-md bg-background px-2.5 py-2 font-mono text-[12px] whitespace-pre-wrap text-muted-foreground">
          {block.text}
          {block.truncated ? '\n…' : ''}
        </pre>
      )}
    </li>
  )
}
