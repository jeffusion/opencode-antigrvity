import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AgyAbortError, AgyError, AgyTimeoutError } from "./errors.js";
import { info } from "./log.js";

/*
 * Tool-resume diagnostics. Stage summaries are logged at info level on
 * purpose: the debug gate in log.ts is off by default and would hide exactly
 * the evidence a diagnostic build exists to collect. Metadata fields pass a
 * compile-time and runtime allowlist (generated ids, counts, controlled
 * categories, timings, native UUID file names); never auth material, headers,
 * prompts, tool names/arguments/results or raw error text. MCP "reply ready"
 * means the response was constructed or enqueued locally; it is not a
 * network-delivery or native-acknowledgement claim.
 */

const SCENE_LIMIT_BYTES = 64 * 1024 * 1024;
const SCENE_CHUNK_BYTES = 1024 * 1024;
const SCENE_ROOT = "diagnostics";
const SCENE_NAME = "timeout-scene";
const SCENE_MAX_FILES = 8;
const NATIVE_CONVERSATIONS = join("antigravity-acp", "conversations");
const NATIVE_DB_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db$/i;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_RDONLY = fsConstants.O_RDONLY;

type StageField =
  | "stage" | "req" | "turn" | "route" | "ms" | "tools" | "results" | "stream"
  | "candidates" | "reason" | "outcome" | "pending" | "total" | "transport"
  | "waitMs" | "sinceBindMs" | "scene" | "files" | "bytes" | "code" | "name"
  | "needed" | "limit" | "cause";

/** Runtime mirror of StageField: emit drops anything outside this set. */
const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "stage", "req", "turn", "route", "ms", "tools", "results", "stream", "candidates",
  "reason", "outcome", "pending", "total", "transport", "waitMs", "sinceBindMs",
  "scene", "files", "bytes", "code", "name", "needed", "limit", "cause",
]);

type StageMetadata = Partial<Record<StageField, string | number | boolean>>;

function emit(message: string, metadata: StageMetadata): void {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined && ALLOWED_FIELDS.has(key)) clean[key] = value;
  }
  info(message, clean);
}

/** A per-HTTP-request stage summary, correlated by a generated request id. */
export function requestStage(requestId: string, stage: string, metadata: StageMetadata = {}): void {
  emit("diag request", { stage, req: requestId, ...metadata });
}

/** Maps an arbitrary close reason to a controlled category. Raw messages,
 * stacks and client-supplied identifiers never reach the log. */
export function closeCategory(reason: unknown): string {
  if (reason instanceof AgyAbortError) return "cancelled";
  if (reason instanceof AgyTimeoutError) return "acp_stall_timeout";
  if (reason instanceof DOMException) {
    if (reason.name === "TimeoutError") return "deadline_timeout";
    if (reason.name === "AbortError") return "aborted";
    return "dom_exception";
  }
  if (reason instanceof AgyError) return reason.kind;
  if (reason instanceof Error) return "error";
  return "other";
}

/** Controlled diagnostic cause for an abort reason, derived at the explicit
 * call site that observed the abort (the request signal), never guessed from
 * a default cleanup path. */
export function abortCause(reason: unknown): string {
  if (reason instanceof DOMException) {
    if (reason.name === "TimeoutError") return "deadline_timeout";
    if (reason.name === "AbortError") return "client_abort";
    return "aborted";
  }
  if (reason instanceof AgyError) return reason.kind;
  return "aborted";
}

type BoundRequest = { id: string; boundAt: number; firstUpdateMs?: number };

/**
 * Metadata-only trace for one ACP turn. A tool turn keeps one instance across
 * all HTTP continuations; a continuation binds its request id only after its
 * resume passed validation and budget, just before the results resolve, so an
 * update that fires immediately afterwards is attributed to the resuming
 * request while a rejected continuation cannot steal the diagnostic owner.
 */
export class TurnDiagnostics {
  readonly turnId = randomUUID();
  private request: BoundRequest;
  private sceneFlagged = false;
  private readonly scene?: TimeoutSceneCollector;

  constructor(requestId: string, scene?: TimeoutSceneCollector) {
    this.request = { id: requestId, boundAt: performance.now() };
    this.scene = scene;
  }

  bindRequest(requestId: string): void {
    this.request = { id: requestId, boundAt: performance.now() };
  }

  /** Producer-side signal from the ACP worker's onActivity hook: it fires when
   * a session update is enqueued, not when a paused consumer reads it. */
  noteAcpUpdate(): void {
    const request = this.request;
    if (request.firstUpdateMs !== undefined) return;
    request.firstUpdateMs = performance.now();
    emit("diag turn", {
      stage: "acp_first_update", turn: this.turnId, req: request.id,
      sinceBindMs: Math.round(request.firstUpdateMs - request.boundAt),
    });
  }

  mcpCallRegistered(pending: number, total: number): void {
    emit("diag turn", { stage: "mcp_call_registered", turn: this.turnId, pending, total });
  }

  mcpReplyReady(transport: "json" | "sse"): void {
    emit("diag turn", { stage: "mcp_reply_ready", turn: this.turnId, transport });
  }

  mcpRejected(reason: unknown): void {
    emit("diag turn", { stage: "mcp_rejected", turn: this.turnId, reason: closeCategory(reason) });
  }

  toolWaitTimeout(waitMs: number): void {
    emit("diag turn", { stage: "tool_wait_timeout", turn: this.turnId, waitMs });
  }

  /** Logs the explicit close cause from the call site; a default cleanup
   * close must never be reported as a client cancel. Only the request-deadline
   * cause flags the timeout scene. */
  turnCloseStarted(cause: string): void {
    emit("diag turn", { stage: "turn_close_started", turn: this.turnId, req: this.request.id, cause });
    if (cause === "deadline_timeout" && this.scene) {
      this.sceneFlagged = true;
      emit("diag turn", { stage: "scene_flagged", turn: this.turnId, req: this.request.id });
    }
  }

  /** Retains this turn's native conversation store after awaiting the worker
   * stop attempt, before workspace cleanup; this does not prove native exit.
   * It is never a pre-cancel snapshot. Never throws, so it cannot
   * mask the original request failure or block the workspace cleanup. */
  async captureScene(workspace: string): Promise<void> {
    if (!this.sceneFlagged || !this.scene) return;
    this.sceneFlagged = false;
    await this.scene.capture({ workspace, turnId: this.turnId, requestId: this.request.id });
  }
}

type SceneRequest = { workspace: string; turnId: string; requestId?: string };
type SourcePart = { name: string; path: string; stat: BigIntStats };
type SceneFile = {
  name: string; bytes: number; sha256: string; stable: boolean;
  dev: string; ino: string; mtimeNs: string; ctimeNs: string;
  readStartedAt: number; readEndedAt: number;
};

type SourceSelection =
  | { ok: true; parts: SourcePart[] }
  | { ok: false; stage: "gap" | "skipped"; reason: string; meta?: StageMetadata };

type PartResult =
  | { ok: true; bytes: number; file: SceneFile }
  | { ok: false; stage: "gap"; reason: string };

/** Exact nanosecond identity from bigint stats: dev, ino, size, mtimeNs, ctimeNs. */
function identity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** One retain attempt per service instance, at most 64 MiB, no polling and no
 * retry. Every failure path logs an explicit gap/skip; success is never
 * claimed for a partial copy. The .db/.db-wal pair is not an atomic SQLite
 * backup: the manifest records original hashes, sizes and stability checks so
 * the copy can be recovered offline. */
export class TimeoutSceneCollector {
  private attemptedValue = false;

  constructor(private readonly dataRoot: string, private readonly limitBytes = SCENE_LIMIT_BYTES) {}

  get attempted(): boolean { return this.attemptedValue; }

  async capture(request: SceneRequest): Promise<void> {
    if (this.attemptedValue) {
      emit("diag scene", { stage: "skipped", reason: "already_attempted", turn: request.turnId, req: request.requestId });
      return;
    }
    // Claim the single attempt up front, so a failing or racing capture can
    // never grow into a retry loop.
    this.attemptedValue = true;
    const startedAt = performance.now();
    let temp: string | undefined;
    let renamed = false;
    try {
      const selection = await this.selectSources(request);
      if (!selection.ok) {
        emit("diag scene", { stage: selection.stage, reason: selection.reason, turn: request.turnId, req: request.requestId, ...selection.meta });
        return;
      }
      const root = await this.sceneRoot();
      if (typeof root !== "string") {
        emit("diag scene", { stage: "skipped", reason: root.reason, turn: request.turnId, req: request.requestId, code: root.code });
        return;
      }
      temp = await mkdtemp(join(root, "scene-"));
      await chmod(temp, 0o700);
      const files: SceneFile[] = [];
      let remaining = this.limitBytes;
      let bytes = 0;
      for (const part of selection.parts) {
        const copied = await this.copyPart(part, temp, remaining);
        if (!copied.ok) {
          emit("diag scene", { stage: copied.stage, reason: copied.reason, turn: request.turnId, req: request.requestId, name: part.name });
          return;
        }
        remaining -= copied.bytes;
        bytes += copied.bytes;
        files.push(copied.file);
      }
      // Re-select and compare the complete file set and identities: a db that
      // changed while its wal streamed, or a wal that only appeared during the
      // copy, is a gap, never a captured scene.
      const finalSelection = await this.selectSources(request);
      const originalIdentities = new Map(selection.parts.map(part => [part.name, identity(part.stat)]));
      const unchanged = finalSelection.ok && finalSelection.parts.length === originalIdentities.size &&
        finalSelection.parts.every(part => originalIdentities.get(part.name) === identity(part.stat));
      if (!unchanged) {
        emit("diag scene", { stage: "gap", reason: "source_set_changed", turn: request.turnId, req: request.requestId });
        return;
      }
      const manifest = {
        kind: "agy-api-timeout-scene",
        sceneId: randomUUID(),
        note: "Read-only copy of the request workspace's native conversation .db/.db-wal, taken after the ACP worker stop was attempted and before the workspace cleanup. A stop that throws is not proof the native tree exited; this is a pre-cleanup snapshot, not the pre-cancel native state, and the pair is not an atomic SQLite backup.",
        turnId: request.turnId,
        timeoutRequestId: request.requestId,
        workspace: basename(request.workspace),
        pid: process.pid,
        collectedAt: new Date().toISOString(),
        collectionMs: Math.round(performance.now() - startedAt),
        limitBytes: this.limitBytes,
        bytes,
        files,
      };
      const manifestPath = join(temp, "manifest.json");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      await chmod(manifestPath, 0o600);
      const target = join(root, SCENE_NAME);
      // Existing evidence is never replaced, not even an empty target. The
      // pre-check plus rename is not an atomic cross-process guarantee; the
      // service file lock and the single per-instance collector bound the race.
      if (await lstat(target).then(() => true, () => false)) {
        emit("diag scene", { stage: "skipped", reason: "target_exists", turn: request.turnId, req: request.requestId });
        return;
      }
      try { await rename(temp, target); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR" || code === "ENOTDIR") {
          emit("diag scene", { stage: "skipped", reason: "target_exists", turn: request.turnId, req: request.requestId });
          return;
        }
        throw error;
      }
      renamed = true;
      emit("diag scene", {
        stage: "captured", scene: SCENE_NAME, files: files.length, bytes,
        ms: Math.round(performance.now() - startedAt), turn: request.turnId, req: request.requestId,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      emit("diag scene", {
        stage: "skipped", reason: "io_error", code: typeof code === "string" ? code : "unknown",
        turn: request.turnId, req: request.requestId,
      });
    } finally {
      if (temp && !renamed) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The scene root must be a real, controlled directory under the data root
   * before anything is written: an existing symlink or non-directory is
   * refused, so no temp file can ever land outside the data root. */
  private async sceneRoot(): Promise<string | { reason: string; code?: string }> {
    const dataStat = await lstat(this.dataRoot).catch(() => undefined);
    if (!dataStat?.isDirectory() || dataStat.isSymbolicLink()) return { reason: "data_root_unavailable" };
    const root = join(this.dataRoot, SCENE_ROOT);
    let stat = await lstat(root).catch(() => undefined);
    if (!stat) {
      const error = await mkdir(root, { mode: 0o700 }).catch((failure: unknown) => failure as NodeJS.ErrnoException);
      if (error && error.code !== "EEXIST") return { reason: "io_error", code: typeof error.code === "string" ? error.code : "unknown" };
      stat = await lstat(root).catch(() => undefined);
    }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return { reason: "scene_root_not_directory" };
    await chmod(root, 0o700);
    const realData = await realpath(this.dataRoot).catch(() => undefined);
    const realRoot = await realpath(root).catch(() => undefined);
    if (!realData || realRoot !== join(realData, SCENE_ROOT)) return { reason: "scene_root_not_directory" };
    return root;
  }

  private async selectSources(request: SceneRequest): Promise<SourceSelection> {
    const workRoot = await realpath(resolve(this.dataRoot, "work")).catch(() => undefined);
    if (!workRoot) return { ok: false, stage: "skipped", reason: "work_root_unavailable" };
    const workspace = await realpath(request.workspace).catch(() => undefined);
    if (!workspace) return { ok: false, stage: "skipped", reason: "workspace_missing" };
    const contained = relative(workRoot, workspace);
    if (!contained.startsWith("request-") || contained.includes(sep) || isAbsolute(contained)) {
      return { ok: false, stage: "skipped", reason: "workspace_not_owned" };
    }
    const acpDir = join(request.workspace, "antigravity-acp");
    const conversations = join(request.workspace, NATIVE_CONVERSATIONS);
    for (const directory of [request.workspace, acpDir, conversations]) {
      const stat = await lstat(directory).catch(() => undefined);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) return { ok: false, stage: "skipped", reason: "conversations_unavailable" };
    }
    const realConversations = await realpath(conversations).catch(() => undefined);
    if (realConversations !== join(workspace, NATIVE_CONVERSATIONS)) {
      return { ok: false, stage: "skipped", reason: "conversations_linked" };
    }
    const entries = await readdir(conversations, { withFileTypes: true }).catch(() => undefined);
    if (!entries) return { ok: false, stage: "skipped", reason: "conversations_unreadable" };
    const parts: SourcePart[] = [];
    let total = 0;
    // Only native UUID-named conversation stores are accepted, so a stray or
    // hostile file name can never ride into the log or the manifest.
    for (const entry of entries.filter(item => item.name.endsWith(".db") && NATIVE_DB_NAME.test(item.name))) {
      for (const name of [entry.name, `${entry.name}-wal`]) {
        const path = join(conversations, name);
        const stat = await lstat(path, { bigint: true }).catch((failure: unknown) => failure as NodeJS.ErrnoException);
        if (stat instanceof Error) {
          const code = stat.code;
          // Only a plainly absent optional WAL counts as missing; any other
          // read error is an explicit gap, never a silent absence.
          if (name.endsWith("-wal")) {
            if (code === "ENOENT") continue;
            return { ok: false, stage: "gap", reason: "source_unreadable", meta: { name, code } };
          }
          return { ok: false, stage: code === "ENOENT" ? "skipped" : "gap", reason: code === "ENOENT" ? "source_missing" : "source_unreadable", meta: { name, code } };
        }
        if (stat.isSymbolicLink()) return { ok: false, stage: "skipped", reason: "source_symlink", meta: { name } };
        if (!stat.isFile()) return { ok: false, stage: "skipped", reason: "source_not_regular", meta: { name } };
        // Sizes stay far below Number.MAX_SAFE_INTEGER under the byte limit.
        total += Number(stat.size);
        parts.push({ name, path, stat });
      }
    }
    if (!parts.length) return { ok: false, stage: "skipped", reason: "no_conversation_db" };
    if (parts.length > SCENE_MAX_FILES) {
      return { ok: false, stage: "gap", reason: "file_count_over_limit", meta: { files: parts.length, limit: SCENE_MAX_FILES } };
    }
    if (total > this.limitBytes) {
      return { ok: false, stage: "gap", reason: "size_over_limit", meta: { needed: total, limit: this.limitBytes } };
    }
    return { ok: true, parts };
  }

  /** Capped, chunked read with full before/after identity checks, so a growing
   * file cannot push the copy past the byte limit or pass as stable. */
  private async copyPart(part: SourcePart, temp: string, remaining: number): Promise<PartResult> {
    let input: FileHandle;
    try { input = await open(part.path, O_RDONLY | NOFOLLOW); }
    catch { return { ok: false, stage: "gap", reason: "open_failed" }; }
    let output: FileHandle | undefined;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(SCENE_CHUNK_BYTES);
    const readStartedAt = Date.now();
    let bytes = 0;
    try {
      const opened = await input.stat({ bigint: true });
      if (!opened.isFile() || identity(opened) !== identity(part.stat)) {
        return { ok: false, stage: "gap", reason: "source_swapped" };
      }
      const target = join(temp, part.name);
      output = await open(target, "wx", 0o600);
      while (true) {
        const { bytesRead } = await input.read(buffer, 0, SCENE_CHUNK_BYTES, null);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > remaining) return { ok: false, stage: "gap", reason: "grew_over_limit" };
        const chunk = buffer.subarray(0, bytesRead);
        // writeFile writes the whole buffer; a short write cannot silently
        // truncate the copy while the manifest claims a full hash.
        await output.writeFile(chunk);
        hash.update(chunk);
      }
      const after = await input.stat({ bigint: true });
      const afterPath = await lstat(part.path, { bigint: true }).catch(() => undefined);
      const stable = identity(after) === identity(opened) && bytes === Number(part.stat.size) &&
        afterPath !== undefined && afterPath.dev === part.stat.dev && afterPath.ino === part.stat.ino;
      if (!stable) return { ok: false, stage: "gap", reason: "source_changed" };
      await chmod(target, 0o600);
      return {
        ok: true, bytes,
        file: {
          name: part.name, bytes, sha256: hash.digest("hex"), stable,
          dev: String(after.dev), ino: String(after.ino),
          mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs),
          readStartedAt, readEndedAt: Date.now(),
        },
      };
    } finally {
      if (output) await output.close().catch(() => undefined);
      await input.close().catch(() => undefined);
    }
  }
}
