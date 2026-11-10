import { AgyError } from "./errors.js";

export function acceptsMcpSse(request: Request): boolean {
  return request.headers.get("accept")?.split(",").some(value =>
    value.trim().split(";")[0] === "text/event-stream" && !/;\s*q=0(?:\.0*)?(?:\s*;|\s*$)/i.test(value)) ?? false;
}

/** MCP progress is opt-in via progressToken and a negotiated SSE response.
 * A waiting notification reports zero completed work; comments are transport
 * keepalive, never fabricated increasing work progress or successful results. */
export function mcpProgressResponse(id: unknown, progressToken: string | number, result: Promise<unknown>, cancel: () => void, intervalMs = 15_000, message = "Waiting for client tool execution", onHandedOff?: (result: unknown) => Promise<void>): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(payload)}\n\n`));
      send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: 0, message } });
      timer = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n")); }, intervalMs);
      timer.unref?.();
      const finish = (payload: unknown) => { clearInterval(timer); if (closed) return false; send(payload); controller.close(); closed = true; return true; };
      void result.then(async value => { if (finish({ jsonrpc: "2.0", id, result: value })) await onHandedOff?.(value); }, error => finish({ jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : "MCP request failed" } })).catch(() => { /* Durable intent remains; no remote acknowledgement is inferred. */ });
    },
    cancel() { closed = true; clearInterval(timer); cancel(); },
  }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

export async function readMcpBody(request: Request, max = 8 * 1024 * 1024, deadlineMs = 15_000): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    reject(new AgyError("timeout", "MCP body read deadline exceeded")); void reader.cancel().catch(() => {});
  }, deadlineMs); });
  try {
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > max) throw new AgyError("invalid_request", "MCP request too large");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
