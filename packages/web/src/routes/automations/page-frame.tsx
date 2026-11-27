/** Framed status box used by automation views while loading or showing an empty filter result. */
export function PageState({ text }: { text: string }) {
  return <div role="status" className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">{text}</div>
}
