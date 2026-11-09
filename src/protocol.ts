import type { PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import { AgyProcessError } from "./errors.js";

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

  push(event: AcpEvent): AcpEvent[] {
    if (event.event !== "update" || event.update.sessionUpdate !== "agent_message_chunk" || event.update.content.type !== "text") {
      const output = this.flush();
      this.passthrough = false;
      return [...output, event];
    }
    const text = event.update.content.text;
    if (this.passthrough) return [event];
    // Empty chunks carry no text and must not grow the prefix queue.
    if (!text) return [];
    const previousPrefix = this.prefix;
    this.prefix += text.slice(0, harnessFailureHeader.length - this.prefix.length);
    this.held.push(event);
    if (isHarnessFailure(this.prefix)) throw new AgyProcessError(previousPrefix + text);
    if (harnessFailureHeader.startsWith(this.prefix)) return [];
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
