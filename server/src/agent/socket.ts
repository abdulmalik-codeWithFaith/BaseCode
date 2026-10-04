import { WebSocket } from "ws";
import { AgentSession } from "./loop.js";
import type { AgentEvent } from "./types.js";

const MAX_PROMPT_CHARS = 20_000;

/**
 * One AgentSession per WebSocket. Client -> server (JSON):
 *   { type: "user", text, autoApprove? }   start a request
 *   { type: "approve", id, allow }          answer an approval_request
 *   { type: "stop" }                        cancel the current request
 *   { type: "reset" }                       forget the conversation
 * Server -> client: AgentEvent JSON frames.
 */
export function attachAgent(ws: WebSocket): void {
  const send = (event: AgentEvent) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  };
  const session = new AgentSession(send);

  ws.on("message", (raw) => {
    let msg: { type?: string; text?: unknown; autoApprove?: unknown; id?: unknown; allow?: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case "user": {
        const text = typeof msg.text === "string" ? msg.text.trim() : "";
        if (!text) return;
        if (text.length > MAX_PROMPT_CHARS) {
          send({ type: "error", message: `That message is too long (limit ${MAX_PROMPT_CHARS} characters).`, code: "too_long" });
          return;
        }
        void session.run(text, msg.autoApprove === true);
        break;
      }
      case "approve":
        if (typeof msg.id === "string") session.approve(msg.id, msg.allow === true);
        break;
      case "stop":
        session.stop();
        break;
      case "reset":
        session.reset();
        break;
    }
  });

  ws.on("close", () => session.dispose());
  ws.on("error", () => session.dispose());
}