import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyAbortError, AgyError, AgyTimeoutError } from "../src/errors.js";
import { abortCause, closeCategory, requestStage, TimeoutSceneCollector, TurnDiagnostics } from "../src/service-diagnostics.js";
import { geminiJson, parseGeminiContent } from "../src/gemini-content.js";
import { ClientToolTurn } from "../src/tool-turn.js";
import { fixtureCompatibility } from "./fixtures/compatibility.js";

let lines: string[] = [];
const originalInfo = console.info;

async function withLogs<T>(run: () => Promise<T>): Promise<T> {
  lines = [];
  console.info = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try { return await run(); }
  finally { console.info = originalInfo; }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

async function makeWorkspace(data: string, name = "request-test"): Promise<string> {
  const conversations = join(data, "work", name, "antigravity-acp", "conversations");
  await mkdir(conversations, { recursive: true, mode: 0o700 });
  return join(data, "work", name);
}

const deadline = new DOMException("request deadline exceeded", "TimeoutError");
// Real native conversation stores use a plain UUID file name; the sample below
// is the UUID from the read-only host report, never a live database.
const DB = "69ead5a7-47fd-4f15-a35d-d4badab65665.db";
const ALLOWED_KEYS = new Set(["stage", "req", "turn", "route", "ms", "tools", "results", "stream", "candidates",
  "reason", "outcome", "pending", "total", "transport", "waitMs", "sinceBindMs", "scene", "files", "bytes",
  "code", "name", "needed", "limit", "cause"]);

function loggedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const line of lines) for (const match of line.matchAll(/ ([a-zA-Z]+)=/g)) keys.add(match[1]);
  return keys;
}

test("close categories are controlled and cancel never masquerades as a deadline timeout", () => {
  expect(closeCategory(new AgyAbortError())).toBe("cancelled");
  expect(closeCategory(new AgyTimeoutError("stall"))).toBe("acp_stall_timeout");
  expect(closeCategory(deadline)).toBe("deadline_timeout");
  expect(closeCategory(new DOMException("client went away", "AbortError"))).toBe("aborted");
  expect(closeCategory(new AgyError("protocol", "boom"))).toBe("protocol");
  expect(closeCategory(new Error("raw leak"))).toBe("error");
  expect(closeCategory("nonsense")).toBe("other");
});

test("first-update attribution follows the resuming request, once per continuation", async () => {
  await withLogs(async () => {
    const trace = new TurnDiagnostics("req-first");
    trace.noteAcpUpdate();
    trace.noteAcpUpdate();
    trace.bindRequest("req-resume");
    trace.noteAcpUpdate();
    trace.mcpCallRegistered(2, 3);
    trace.mcpReplyReady("sse");
    trace.mcpRejected(new AgyError("protocol", "secret-protocol-message"));
    trace.toolWaitTimeout(180_000);
    trace.turnCloseStarted("cleanup");
  });
  const first = lines.filter(line => line.includes("stage=acp_first_update"));
  expect(first).toHaveLength(2);
  expect(first[0]).toContain("req=req-first");
  expect(first[1]).toContain("req=req-resume");
  expect(first[0]).toContain(`turn=${lines[0].match(/turn=([^\s]+)/)![1]}`);
  // A default cleanup close is labelled as such, never as a client cancel.
  expect(lines.some(line => line.includes("stage=turn_close_started") && line.includes("cause=cleanup"))).toBe(true);
  // Raw error text never reaches a stage log.
  expect(lines.join("\n")).not.toContain("secret-protocol-message");
  for (const key of loggedKeys()) expect(ALLOWED_KEYS.has(key)).toBe(true);
});

test("request stages keep metadata within the diagnostic allowlist", async () => {
  await withLogs(async () => {
    requestStage("req-x", "enter", { route: "messages" });
    requestStage("req-x", "parsed", { ms: 1, tools: 2, results: 3, stream: 0 });
    requestStage("req-x", "lookup_rejected", { candidates: 0, reason: "unknown_call" });
    requestStage("req-x", "closed", { outcome: "complete", ms: 2 });
  });
  // A client-supplied tool id is never part of a rejection log by construction:
  // only counts and controlled reasons are passed.
  expect(lines.join("\n")).not.toContain("call_toolu_secret");
  for (const key of loggedKeys()) expect(ALLOWED_KEYS.has(key)).toBe(true);
});

test("a deadline timeout retains one stable db/wal pair with restrictive modes", async () => {
  const data = await mkdtemp(join(tmpdir(), "agy-scene-"));
  const workspace = await makeWorkspace(data);
  const conversations = join(workspace, "antigravity-acp", "conversations");
  const dbBytes = Buffer.from("sqlite-main-bytes");
  const walBytes = Buffer.from("wal-frame-bytes");
  await writeFile(join(conversations, DB), dbBytes, { mode: 0o600 });
  await writeFile(join(conversations, `${DB}-wal`), walBytes, { mode: 0o600 });
  // A non-native file name must neither be copied nor reach the logs.
  await writeFile(join(conversations, "not-native.db"), "hostile-name-bytes", { mode: 0o600 });
  // Credential-like neighbours must never be copied.
  await writeFile(join(workspace, "antigravity-acp", "acp_token.json"), "token-bytes", { mode: 0o600 });
  const scene = new TimeoutSceneCollector(data);
  const trace = new TurnDiagnostics("req-t", scene);
  await withLogs(async () => {
    trace.turnCloseStarted("deadline_timeout");
    await trace.captureScene(workspace);
  });
  expect(lines.some(line => line.includes("stage=scene_flagged"))).toBe(true);
  const target = join(data, "diagnostics", "timeout-scene");
  expect(await exists(target)).toBe(true);
  expect((await readdir(target)).sort()).toEqual([DB, `${DB}-wal`, "manifest.json"]);
  expect((await readFile(join(target, DB))).equals(dbBytes)).toBe(true);
  expect((await readFile(join(target, `${DB}-wal`))).equals(walBytes)).toBe(true);
  const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
  expect(manifest.turnId).toBe(trace.turnId);
  expect(manifest.timeoutRequestId).toBe("req-t");
  expect(manifest.workspace).toBe("request-test");
  expect(manifest.files.map((file: { name: string }) => file.name).sort()).toEqual([DB, `${DB}-wal`]);
  expect(manifest.files.every((file: { stable: boolean }) => file.stable)).toBe(true);
  expect(manifest.files.find((file: { name: string }) => file.name === DB).sha256)
    .toBe(createHash("sha256").update(dbBytes).digest("hex"));
  // Nanosecond stamps come from bigint stats, not from rounded milliseconds.
  const sourceNs = await lstat(join(conversations, DB), { bigint: true });
  expect(manifest.files.find((file: { name: string }) => file.name === DB).mtimeNs).toBe(String(sourceNs.mtimeNs));
  expect(manifest.files.find((file: { name: string }) => file.name === DB).ctimeNs).toBe(String(sourceNs.ctimeNs));
  expect(JSON.stringify(manifest)).not.toContain("not-native.db");
  expect(lines.join("\n")).not.toContain("not-native.db");
  expect((await lstat(join(target, DB))).mode & 0o777).toBe(0o600);
  expect((await lstat(join(target, "manifest.json"))).mode & 0o777).toBe(0o600);
  expect((await lstat(target)).mode & 0o777).toBe(0o700);
  expect((await readdir(join(data, "diagnostics"))).sort()).toEqual(["timeout-scene"]);
  // A second deadline scene is refused: one attempt per instance.
  await withLogs(async () => {
    const second = new TurnDiagnostics("req-t2", scene);
    second.turnCloseStarted("deadline_timeout");
    await second.captureScene(workspace);
  });
  expect(lines.some(line => line.includes("reason=already_attempted"))).toBe(true);
  expect(scene.attempted).toBe(true);
  await rm(data, { recursive: true, force: true });
});

test("normal completion and cancellation retain nothing", async () => {
  const data = await mkdtemp(join(tmpdir(), "agy-scene-none-"));
  const workspace = await makeWorkspace(data);
  const scene = new TimeoutSceneCollector(data);
  await withLogs(async () => {
    const cancelled = new TurnDiagnostics("req-c", scene);
    cancelled.toolWaitTimeout(180_000);
    cancelled.turnCloseStarted("cleanup");
    await cancelled.captureScene(workspace);
    const plain = new TurnDiagnostics("req-p");
    plain.turnCloseStarted("deadline_timeout");
    await plain.captureScene(workspace);
  });
  expect(lines.some(line => line.includes("stage=scene_flagged"))).toBe(false);
  expect(lines.some(line => line.includes("stage=captured"))).toBe(false);
  expect(await exists(join(data, "diagnostics"))).toBe(false);
  await rm(data, { recursive: true, force: true });
});

test("symlinked sources and linked conversation directories are rejected, not followed", async () => {
  const data = await mkdtemp(join(tmpdir(), "agy-scene-link-"));
  const workspace = await makeWorkspace(data, "request-link");
  const conversations = join(workspace, "antigravity-acp", "conversations");
  const outside = join(data, "outside-secret");
  await writeFile(outside, "credential-like-bytes", { mode: 0o600 });
  await writeFile(join(conversations, DB), "real-bytes", { mode: 0o600 });
  await symlink(outside, join(conversations, `${randomUUID()}.db`));
  const scene = new TimeoutSceneCollector(data);
  await withLogs(async () => {
    const trace = new TurnDiagnostics("req-s", scene);
    trace.turnCloseStarted("deadline_timeout");
    await trace.captureScene(workspace);
  });
  expect(lines.some(line => line.includes("reason=source_symlink"))).toBe(true);
  expect(await exists(join(data, "diagnostics", "timeout-scene"))).toBe(false);
  expect(lines.join("\n")).not.toContain("credential-like-bytes");

  // A conversations directory that is itself a link stays out too.
  const data2 = await mkdtemp(join(tmpdir(), "agy-scene-dirlink-"));
  await mkdir(join(data2, "work"), { recursive: true, mode: 0o700 });
  await mkdir(join(data2, "elsewhere", "conversations"), { recursive: true, mode: 0o700 });
  await writeFile(join(data2, "elsewhere", "conversations", DB), "x", { mode: 0o600 });
  const linkedWorkspace = join(data2, "work", "request-linked");
  await mkdir(join(linkedWorkspace, "antigravity-acp"), { recursive: true, mode: 0o700 });
  await symlink(join(data2, "elsewhere", "conversations"), join(linkedWorkspace, "antigravity-acp", "conversations"));
  const scene2 = new TimeoutSceneCollector(data2);
  await withLogs(async () => {
    const trace = new TurnDiagnostics("req-d", scene2);
    trace.turnCloseStarted("deadline_timeout");
    await trace.captureScene(linkedWorkspace);
  });
  expect(lines.some(line => line.includes("reason=conversations_"))).toBe(true);
  expect(await exists(join(data2, "diagnostics", "timeout-scene"))).toBe(false);
  await rm(data, { recursive: true, force: true });
  await rm(data2, { recursive: true, force: true });
});

test("oversized sources log an explicit gap and copy nothing", async () => {
  const data = await mkdtemp(join(tmpdir(), "agy-scene-big-"));
  const workspace = await makeWorkspace(data);
  const conversations = join(workspace, "antigravity-acp", "conversations");
  await writeFile(join(conversations, DB), Buffer.alloc(64), { mode: 0o600 });
  const scene = new TimeoutSceneCollector(data, 16);
  await withLogs(async () => {
    const trace = new TurnDiagnostics("req-b", scene);
    trace.turnCloseStarted("deadline_timeout");
    await trace.captureScene(workspace);
  });
  expect(lines.some(line => line.includes("stage=gap") && line.includes("reason=size_over_limit"))).toBe(true);
  expect(await exists(join(data, "diagnostics", "timeout-scene"))).toBe(false);
  expect(scene.attempted).toBe(true);
  await rm(data, { recursive: true, force: true });
});

test("more native stores than the bounded scene allows log an explicit gap", async () => {
  const data = await mkdtemp(join(tmpdir(), "agy-scene-count-"));
  const workspace = await makeWorkspace(data);
  const conversations = conversationsOf(workspace);
  for (let index = 0; index < 9; index++) {
    await writeFile(join(conversations, `${randomUUID()}.db`), "x", { mode: 0o600 });
  }
  const scene = new TimeoutSceneCollector(data);
  await withLogs(async () => {
    const trace = new TurnDiagnostics("req-n", scene);
    trace.turnCloseStarted("deadline_timeout");
    await trace.captureScene(workspace);
  });
  expect(lines.some(line => line.includes("stage=gap") && line.includes("reason=file_count_over_limit"))).toBe(true);
  expect(await exists(join(data, "diagnostics", "timeout-scene"))).toBe(false);
  await rm(data, { recursive: true, force: true });
});

test("existing evidence at the scene target is preserved, even when empty", async () => {
  for (const preexisting of ["marker", "empty"]) {
    const data = await mkdtemp(join(tmpdir(), "agy-scene-exists-"));
    const workspace = await makeWorkspace(data);
    await writeFile(join(conversationsOf(workspace), DB), "x", { mode: 0o600 });
    const target = join(data, "diagnostics", "timeout-scene");
    await mkdir(target, { recursive: true, mode: 0o700 });
    if (preexisting === "marker") await writeFile(join(target, "evidence.txt"), "keep-me", { mode: 0o600 });
    const scene = new TimeoutSceneCollector(data);
    await withLogs(async () => {
      const trace = new TurnDiagnostics("req-e", scene);
      trace.turnCloseStarted("deadline_timeout");
      await trace.captureScene(workspace);
    });
    expect(lines.some(line => line.includes("reason=target_exists"))).toBe(true);
    expect((await readdir(target)).sort()).toEqual(preexisting === "marker" ? ["evidence.txt"] : []);
    if (preexisting === "marker") expect(await readFile(join(target, "evidence.txt"), "utf8")).toBe("keep-me");
    // The partial temp directory is removed; only the preserved target remains.
    expect((await readdir(join(data, "diagnostics"))).sort()).toEqual(["timeout-scene"]);
    await rm(data, { recursive: true, force: true });
  }
});

test("a symlinked diagnostics root is refused before anything is written", async () => {
  const data = await mkdtemp(join(tmpdir(), "agy-scene-rootlink-"));
  const workspace = await makeWorkspace(data);
  await writeFile(join(conversationsOf(workspace), DB), "x", { mode: 0o600 });
  const outside = join(data, "outside");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, join(data, "diagnostics"));
  const scene = new TimeoutSceneCollector(data);
  await withLogs(async () => {
    const trace = new TurnDiagnostics("req-r", scene);
    trace.turnCloseStarted("deadline_timeout");
    await trace.captureScene(workspace);
  });
  expect(lines.some(line => line.includes("reason=scene_root_not_directory"))).toBe(true);
  expect(await readdir(outside)).toEqual([]);
  await rm(data, { recursive: true, force: true });
});

test("capture failures never reject and never mask the original failure", async () => {
  const data = await mkdtemp(join(tmpdir(), "agy-scene-io-"));
  await mkdir(join(data, "work"), { recursive: true, mode: 0o700 });
  // Missing workspace: explicit skip, resolved promise.
  const scene = new TimeoutSceneCollector(data);
  await withLogs(async () => {
    const trace = new TurnDiagnostics("req-m", scene);
    trace.turnCloseStarted("deadline_timeout");
    await expect(trace.captureScene(join(data, "work", "request-gone"))).resolves.toBeUndefined();
  });
  expect(lines.some(line => line.includes("reason=workspace_missing"))).toBe(true);
  // A file occupying the diagnostics path is refused before any write.
  const data2 = await mkdtemp(join(tmpdir(), "agy-scene-io2-"));
  const workspace = await makeWorkspace(data2);
  await writeFile(join(conversationsOf(workspace), DB), "x", { mode: 0o600 });
  await writeFile(join(data2, "diagnostics"), "not-a-directory");
  const scene2 = new TimeoutSceneCollector(data2);
  await withLogs(async () => {
    const trace = new TurnDiagnostics("req-i", scene2);
    trace.turnCloseStarted("deadline_timeout");
    await expect(trace.captureScene(workspace)).resolves.toBeUndefined();
  });
  expect(lines.some(line => line.includes("reason=scene_root_not_directory"))).toBe(true);
  expect(await readFile(join(data2, "diagnostics"), "utf8")).toBe("not-a-directory");
  // An unwritable data root fails the mkdir as an io skip, still resolving.
  const data3 = await mkdtemp(join(tmpdir(), "agy-scene-io3-"));
  const workspace3 = await makeWorkspace(data3);
  await writeFile(join(conversationsOf(workspace3), DB), "x", { mode: 0o600 });
  await chmod(data3, 0o500);
  const scene3 = new TimeoutSceneCollector(data3);
  try {
    await withLogs(async () => {
      const trace = new TurnDiagnostics("req-w", scene3);
      trace.turnCloseStarted("deadline_timeout");
      await expect(trace.captureScene(workspace3)).resolves.toBeUndefined();
    });
    expect(lines.some(line => line.includes("stage=skipped") && line.includes("reason=io_error"))).toBe(true);
    expect(await exists(join(data3, "work"))).toBe(true);
  } finally {
    await chmod(data3, 0o700);
  }
  await rm(data, { recursive: true, force: true });
  await rm(data2, { recursive: true, force: true });
  await rm(data3, { recursive: true, force: true });
});

function conversationsOf(workspace: string): string {
  return join(workspace, "antigravity-acp", "conversations");
}

test("deadline close captures the scene before the workspace cleanup removes it", async () => {
  const data = await mkdtemp(join(tmpdir(), "agy-wire-"));
  const work = join(data, "work");
  await mkdir(work, { recursive: true, mode: 0o700 });
  const compatibility = fixtureCompatibility();
  const previousGeminiHome = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = join(data, "profile");
  const model = "fake-model-low";
  const body = parseGeminiContent({
    contents: [{ role: "user", parts: [{ text: "FAKE_MCP_ACTIVITY" }] }],
    tools: [{ functionDeclarations: [{ name: "tool_0", parametersJsonSchema: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] } }] }],
  }, model, false);
  const scene = new TimeoutSceneCollector(data);
  const trace = new TurnDiagnostics("req-create", scene);
  let turn: ClientToolTurn | undefined;
  try {
    turn = new ClientToolTurn({
      directory: work,
      detection: { executable: join(import.meta.dir, "fixtures", "fake-acp.mjs"), args: [], platform: process.platform },
      selected: { requestedModel: model, acpModel: model },
      request: body,
    }, body.tools!, "gemini", 120_000, trace);
    await withLogs(async () => {
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      const events = turn!.segment(signal);
      const payload = await (await geminiJson(events, model)).json();
      const calls = (payload.candidates?.[0]?.content?.parts ?? [])
        .map((part: { functionCall?: unknown }) => part.functionCall).filter(Boolean);
      expect(calls.length).toBeGreaterThan(0);
      expect(turn!.owns((calls[0] as { id: string }).id)).toBe(true);
      // A continuation that fails validation never becomes the trace owner.
      expect(() => turn!.resume("gemini", model, [], [], "req-rejected")).toThrow("matching tool result");
      // The parked turn dies on the request deadline, not on a client cancel.
      await turn!.close(deadline, abortCause(deadline));
      await turn!.done;
    });
  } finally {
    await turn?.close().catch(() => undefined);
    compatibility.mockRestore();
    if (previousGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = previousGeminiHome;
  }
  try {
    const text = lines.join("\n");
    expect(text).toContain("stage=acp_first_update");
    expect(text).toContain("req=req-create");
    expect(text).toContain("stage=turn_close_started");
    expect(text).toContain("cause=deadline_timeout");
    expect(text).toContain("stage=scene_flagged");
    // The collector inspected the workspace before cleanup removed it; a capture
    // that ran after the rm would report workspace_missing instead.
    expect(text).toContain("reason=no_conversation_db");
    expect(text).not.toContain("reason=workspace_missing");
    expect(text).not.toContain("req-rejected");
    expect(scene.attempted).toBe(true);
    expect((await readdir(work)).filter(name => name.startsWith("request-"))).toHaveLength(0);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("a WAL that only appears during the copy turns the scene into a gap", async () => {
  const data = await mkdtemp(join(tmpdir(), "agy-scene-latewal-"));
  const workspace = await makeWorkspace(data);
  const conversations = conversationsOf(workspace);
  // Large enough that the copy spans several event-loop turns.
  await writeFile(join(conversations, DB), Buffer.alloc(32 * 1024 * 1024, 7), { mode: 0o600 });
  const scene = new TimeoutSceneCollector(data);
  const trace = new TurnDiagnostics("req-late", scene);
  trace.turnCloseStarted("deadline_timeout");
  await withLogs(async () => {
    const capture = trace.captureScene(workspace);
    // The scene temp directory only exists after the initial selection fixed
    // the file set, so this WAL is guaranteed to arrive after that selection.
    let tempSeen = false;
    for (let attempt = 0; attempt < 2_000 && !tempSeen; attempt++) {
      tempSeen = (await readdir(join(data, "diagnostics")).catch(() => [] as string[]))
        .some(name => name.startsWith("scene-"));
      if (!tempSeen) await Bun.sleep(1);
    }
    expect(tempSeen).toBe(true);
    await writeFile(join(conversations, `${DB}-wal`), Buffer.alloc(4_096, 1), { mode: 0o600 });
    await capture;
  });
  // The late WAL changes the file set; the scene is never claimed captured.
  expect(lines.some(line => line.includes("stage=gap") && line.includes("reason=source_set_changed"))).toBe(true);
  expect(lines.some(line => line.includes("stage=captured"))).toBe(false);
  expect(await exists(join(data, "diagnostics", "timeout-scene"))).toBe(false);
  expect(await readdir(join(data, "diagnostics"))).toEqual([]);
  await rm(data, { recursive: true, force: true });
});

test("a resumed tool reply logs JSON reply-ready and closes as cleanup", async () => {
  const data = await mkdtemp(join(tmpdir(), "agy-wire-reply-"));
  const work = join(data, "work");
  await mkdir(work, { recursive: true, mode: 0o700 });
  const compatibility = fixtureCompatibility();
  const previousGeminiHome = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = join(data, "profile");
  const model = "fake-model-low";
  const body = parseGeminiContent({
    contents: [{ role: "user", parts: [{ text: "FAKE_MCP_ACTIVITY" }] }],
    tools: [{ functionDeclarations: [{ name: "tool_0", parametersJsonSchema: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] } }] }],
  }, model, false);
  const scene = new TimeoutSceneCollector(data);
  const trace = new TurnDiagnostics("req-create", scene);
  let turn: ClientToolTurn | undefined;
  try {
    turn = new ClientToolTurn({
      directory: work,
      detection: { executable: join(import.meta.dir, "fixtures", "fake-acp.mjs"), args: [], platform: process.platform },
      selected: { requestedModel: model, acpModel: model },
      request: body,
    }, body.tools!, "gemini", 120_000, trace);
    await withLogs(async () => {
      const signal = AbortSignal.timeout(30_000);
      const first = await (await geminiJson(turn!.segment(signal), model)).json();
      const call = (first.candidates?.[0]?.content?.parts ?? [])
        .map((part: { functionCall?: { id: string } }) => part.functionCall).filter(Boolean)[0];
      expect(call).toBeTruthy();
      turn!.resume("gemini", model, [{ id: call!.id, content: [{ type: "text", text: "ok" }], isError: false }], [], "req-resume");
      await (await geminiJson(turn!.segment(signal), model)).json();
      await turn!.done;
    });
  } finally {
    await turn?.close().catch(() => undefined);
    compatibility.mockRestore();
    if (previousGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = previousGeminiHome;
    await rm(data, { recursive: true, force: true });
  }
  const text = lines.join("\n");
  expect(text).toContain("stage=mcp_call_registered");
  expect(text).toContain("stage=mcp_reply_ready");
  expect(text).toContain("transport=json");
  // The successful resume binds the new request before its results resolve,
  // so the follow-up update is attributed to the continuation.
  expect(text).toContain("stage=acp_first_update");
  expect(text).toContain("req=req-resume");
  // A normal completion closes as cleanup, never as a client cancel.
  expect(text).toContain("stage=turn_close_started");
  expect(text).toContain("cause=cleanup");
  expect(text).not.toContain("stage=scene_flagged");
  expect(scene.attempted).toBe(false);
});
