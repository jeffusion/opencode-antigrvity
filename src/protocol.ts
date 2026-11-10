import type { PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import { AgyProcessError, type AgyError } from "./errors.js";

// shortcut: CLI text errors are indistinguishable from identical model output; remove when upstream supplies structured errors.
const harnessFailureHeader = "Agent execution error: Harness process exited unexpectedly (WS close code 1011).\nHarness stderr:\n";
export function isHarnessFailure(text: string): boolean {
  return text.startsWith(harnessFailureHeader);
}

/** Only the start of a contiguous assistant text segment is inspected. */
export class HarnessFailureGuard {
  private prefix = "";
  private held: AcpEvent[] = [];
  private passthrough = false;

  constructor(private readonly exactFailure?: { text: string; error: () => AgyError }) {}

  push(event: AcpEvent): AcpEvent[] {
    if (event.event !== "update" || event.update.sessionUpdate !== "agent_message_chunk" || event.update.content.type !== "text") {
      if (this.exactFailure && this.prefix === this.exactFailure.text &&
          (event.event !== "result" || event.result.stopReason === "end_turn")) {
        throw this.exactFailure.error();
      }
      const output = this.flush();
      this.passthrough = false;
      return [...output, event];
    }
    const text = event.update.content.text;
    if (this.passthrough) return [event];
    // Empty chunks carry no text and must not grow the prefix queue.
    if (!text) return [];
    const signature = this.exactFailure?.text ?? harnessFailureHeader;
    // One extra character distinguishes a complete error from longer model output.
    const limit = signature.length + (this.exactFailure ? 1 : 0);
    const previousPrefix = this.prefix;
    this.prefix += text.slice(0, limit - this.prefix.length);
    this.held.push(event);
    if (!this.exactFailure && isHarnessFailure(this.prefix)) throw new AgyProcessError(previousPrefix + text);
    if (signature.startsWith(this.prefix)) return [];
    this.passthrough = true;
    return this.flush();
  }

  flush(): AcpEvent[] {
    const output = this.held;
    this.held = [];
    this.prefix = "";
    return output;
  }
}

export type { ContentBlock, PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";

/** Internal response metadata; separate from ACP's request-token accounting. */
export type ContextOccupancy = { used: number };

export type AcpEvent =
  | { event: "update"; sessionId: string; update: SessionUpdate }
  | { event: "result"; sessionId: string; result: PromptResponse; contextOccupancy?: ContextOccupancy };

export function isSuccessfulResult(event: AcpEvent): boolean {
  return event.event === "result" && event.result.stopReason === "end_turn";
}
