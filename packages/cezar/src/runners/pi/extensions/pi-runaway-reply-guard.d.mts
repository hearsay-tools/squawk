export default function registerPiRunawayReplyGuard(pi: {
  on(type: string, handler: (event: never, ctx: { abort(): void }) => unknown): void;
}): void;
