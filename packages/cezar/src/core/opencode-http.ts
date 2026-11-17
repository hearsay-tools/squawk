/** Short native JSON requests. The long-poll skill command uses its own background reader. */
export async function opencodeHttp(
  baseUrl: string | undefined, method: string, path: string, body?: unknown, signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!baseUrl) throw new Error('opencode server not ready');
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    ...(signal !== undefined ? { signal } : {}),
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status} ${detail.slice(0, 200)}`);
  }
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
