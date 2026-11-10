import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ensureAcpServer } from "./acp-detect.js";
import { errorResponse, readJson } from "./anthropic-http.js";
import { AgyError } from "./errors.js";
import { acquireFileLock } from "./file-lock.js";
import { geminiErrorResponse, geminiJson, geminiStream, parseGeminiContent } from "./gemini-content.js";
import { ModelCatalog } from "./model-catalog.js";
import { resolveAcpModelSelection } from "./models.js";
import { openAIErrorResponse, openAIJson, openAIStream, parseChatCompletion } from "./openai-chat.js";
import { anthropicStream, jsonMessage, parseMessage, publicFailure, streamTurn, textTurn } from "./service-messages.js";
import { ClientToolTurn, type ToolProtocol } from "./tool-turn.js";

// 8 MiB of images expands to about 10.7 MiB in base64.
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_IN_FLIGHT = 4;
const REQUEST_TIMEOUT_MS = 180_000;
const DRAIN_MS = 5_000;

function digest(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

async function prepareCredentials(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pluginHome = join(homedir(), ".gemini");
  const fromPlugin = relative(await realpath(pluginHome).catch(() => pluginHome), await realpath(directory));
  if (!fromPlugin || (fromPlugin !== ".." && !fromPlugin.startsWith(`..${sep}`) && !isAbsolute(fromPlugin))) {
    throw new Error("Use a dedicated AGY_CREDENTIALS_DIR for the service");
  }
  for (const entry of ["antigravity-cli", "antigravity-acp", "antigravity-cli/antigravity-oauth-token",
    "antigravity-acp/acp_token.json", "antigravity-acp/acp_business_token.json", "antigravity-acp/settings.json"]) {
    const stat = await lstat(join(directory, entry)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (stat?.isSymbolicLink()) throw new Error("The service credential directory must not contain linked credential paths");
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`Usage: agy-api
  AGY_API_KEY          Required API key (at least 32 bytes)
  AGY_HOST             Listen address (default 127.0.0.1)
  AGY_PORT             Listen port (default 8787)
  AGY_DATA_DIR         Private state directory (default ~/.local/share/agy-api)
  AGY_CREDENTIALS_DIR  agy CLI login directory (default AGY_DATA_DIR/credentials)

GET /healthz, GET /readyz, GET /v1/models, POST /v1/messages, POST /v1/chat/completions
GET /v1beta/models, POST /v1beta/models/{model}:generateContent or :streamGenerateContent
Authenticate with x-api-key or Authorization: Bearer. Gemini routes also accept x-goog-api-key.
Use a TLS reverse proxy for remote access. All three generation protocols accept inline images
and client-side function calling. Output token budgets are advisory.`);
    return;
  }

  const key = process.env.AGY_API_KEY;
  if (!key || Buffer.byteLength(key) < 32 || /\s/.test(key)) throw new Error("Set AGY_API_KEY to a secret of at least 32 bytes without whitespace");
  const keyHash = digest(key);
  delete process.env.AGY_API_KEY;
  const hostname = process.env.AGY_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.AGY_PORT ?? 8787);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("AGY_PORT must be a valid TCP port");

  const data = resolve(process.env.AGY_DATA_DIR?.trim() || join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "agy-api"));
  const credentials = resolve(process.env.AGY_CREDENTIALS_DIR?.trim() || join(data, "credentials"));
  const directory = join(data, "work");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await prepareCredentials(credentials);
  process.env.GEMINI_HOME = credentials;
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = data;
  const release = await acquireFileLock(join(data, ".service.lock"));
  try {
    await serve(directory, hostname, port, keyHash);
  } finally {
    await release();
  }
}

async function serve(directory: string, hostname: string, port: number, keyHash: Buffer): Promise<void> {
  const stop = new AbortController();
  const finished = Promise.withResolvers<void>();
  const active = new Set<Promise<void>>();
  const toolTurns = new Set<ClientToolTurn>();
  let workers = 0;
  let draining = false;
  let discovery: Promise<void> | undefined;
  let detection: Awaited<ReturnType<typeof ensureAcpServer>> | undefined;
  const catalog = new ModelCatalog(directory, { cache: false });
  const ready = () => !draining && detection && catalog.catalog.source === "acp" && catalog.catalog.models.length > 0 && !catalog.lastError;

  const server = Bun.serve({
    hostname, port, idleTimeout: 0, maxRequestBodySize: MAX_REQUEST_BYTES,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/healthz") return Response.json({ ok: true });
      if (request.method === "GET" && path === "/readyz") return Response.json({ ready: !!ready() }, { status: ready() ? 200 : 503 });
      const list = request.method === "GET" && path === "/v1/models";
      const geminiList = request.method === "GET" && path === "/v1beta/models";
      const generate = request.method === "POST" ? /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/.exec(path) : null;
      const chat = request.method === "POST" && path === "/v1/chat/completions";
      const gemini = geminiList || generate !== null;
      if (!gemini && !list && !chat && !(request.method === "POST" && path === "/v1/messages")) return new Response("Not Found", { status: 404 });
      const fail = gemini ? geminiErrorResponse : chat ? openAIErrorResponse : errorResponse;

      const authorization = request.headers.get("authorization");
      const googleKey = gemini ? request.headers.get("x-goog-api-key") : null;
      const key = googleKey ?? request.headers.get("x-api-key") ?? authorization?.match(/^Bearer (\S+)$/i)?.[1];
      if (!key || !timingSafeEqual(digest(key), keyHash)) return fail(new AgyError("auth", "Invalid API key"));
      if (!ready() || !detection) return fail(new AgyError("overload", "Antigravity is not ready"));
      if (list) {
        return Response.json({ object: "list", data: catalog.catalog.models.map(({ id }) => ({
          id, object: "model", created: Math.floor(catalog.catalog.discoveredAt / 1000), owned_by: "antigravity",
        })) });
      }
      if (geminiList) {
        return Response.json({ models: catalog.catalog.models.map(({ id, name }) => ({
          name: `models/${id}`, baseModelId: id, displayName: name, supportedGenerationMethods: ["generateContent"],
        })) });
      }
      if (active.size >= MAX_IN_FLIGHT) return fail(new AgyError("overload", "The service is at its concurrency limit"));

      const done = Promise.withResolvers<void>();
      let plainTurn = false;
      const settled = () => {
        if (plainTurn) workers--;
        active.delete(done.promise);
        done.resolve();
      };
      active.add(done.promise);
      const client = new AbortController();
      const signal = AbortSignal.any([request.signal, client.signal, stop.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
      let streaming = false;
      try {
        const payload = await readJson(request, MAX_REQUEST_BYTES, signal);
        let modelId = "";
        if (generate) {
          try { modelId = decodeURIComponent(generate[1]); }
          catch { throw new AgyError("invalid_request", "Invalid model resource name"); }
        }
        const protocol: ToolProtocol = generate ? "gemini" : chat ? "openai" : "anthropic";
        const { request: body, includeUsage } = chat
          ? parseChatCompletion(payload)
          : { request: generate ? parseGeminiContent(payload, modelId, generate[2] === "streamGenerateContent") : parseMessage(payload), includeUsage: false };
        const selected = resolveAcpModelSelection(body.model, undefined, catalog.catalog);
        const model = selected.requestedModel;
        const turn = { directory, detection, selected, request: body };
        let tools: ClientToolTurn | undefined;
        const { responses } = body;
        if (responses) {
          tools = [...toolTurns].find(turn => turn.protocol === protocol && turn.owns(responses[0].id));
          if (!tools) throw new AgyError("invalid_request", "The tool call is unknown, expired, or already resumed");
          signal.throwIfAborted();
          tools.resume(protocol, model, responses, body.steering);
        } else {
          if (workers >= MAX_IN_FLIGHT) throw new AgyError("overload", "The service is at its concurrency limit");
          if (body.tools) {
            const pending = new ClientToolTurn(turn, body.tools, protocol);
            tools = pending;
            toolTurns.add(pending);
            void pending.done.then(() => { toolTurns.delete(pending); workers--; });
          } else plainTurn = true;
          workers++;
        }
        const events = tools ? tools.segment(signal) : textTurn({ ...turn, signal });
        if (!body.stream) return await (generate ? geminiJson : chat ? openAIJson : jsonMessage)(events, model);
        const frames = generate ? geminiStream(model) : chat ? openAIStream(model, includeUsage) : anthropicStream(model);
        const response = await streamTurn(events, frames, signal, () => client.abort(), settled);
        streaming = true;
        return response;
      } catch (error) {
        return fail(publicFailure(error, signal));
      } finally {
        if (!streaming) settled();
      }
    },
  });

  async function shutdown(): Promise<void> {
    if (draining) return;
    draining = true;
    const closed = catalog.close();
    const httpClosed = server.stop(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = Promise.all([...active]);
    try {
      const graceful = await Promise.race([
        Promise.all([drained, httpClosed]).then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), DRAIN_MS); }),
      ]);
      stop.abort(new AgyError("overload", "The service is shutting down"));
      if (!graceful) await server.stop(true);
      await Promise.all([drained, ...[...toolTurns].map(turn => turn.close())]);
    } finally {
      clearTimeout(timer);
      await closed;
      await discovery;
      finished.resolve();
    }
  }

  const onSignal = () => { void shutdown().catch(finished.reject); };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  console.log(`agy-api listening on ${server.url.origin}`);
  discovery = (async () => {
    try {
      detection = await ensureAcpServer(undefined, stop.signal);
      if (draining) return;
      process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = detection.executable;
      await catalog.start();
      console.log(ready() ? "agy-api model catalog ready" : "agy-api model catalog unavailable. Check the ACP installation and agy login.");
    } catch {
      if (!draining) {
        console.error("agy-api could not prepare ACP. Check the installation or network.");
        process.exitCode = 1;
        onSignal();
      }
    }
  })();
  await finished.promise;
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "agy-api failed");
  process.exitCode = 1;
});
