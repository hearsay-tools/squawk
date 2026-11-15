type Event = { type: string; properties: Record<string, unknown> };
type Route = readonly [(body: string) => boolean, (body: string) => Promise<void>];
interface Response { writeHead(status: number, headers: Record<string, string>): unknown; end(body: string): unknown }
export function questionReplies(deps: {
  send: (event: Event) => void;
  info: (extra: Record<string, unknown>) => Record<string, unknown>;
  finishText: (text: string) => Promise<string>;
  sessionId: () => string;
  messageId: string;
}): {
  pendingQuestions: { id: string; sessionID: string }[];
  replyToQuestion(req: unknown, res: Response, url: string, body: string): void;
  promptRoutes: Route[];
};
