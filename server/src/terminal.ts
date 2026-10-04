import os from "node:os";
import { WebSocket } from "ws";
import * as pty from "node-pty";
import { cleanEnv } from "./env.js";
import { WORKSPACE_ROOT } from "./workspace.js";

interface Session {
  proc: pty.IPty;
  ws: WebSocket;
}

/**
 * One PTY per WebSocket connection. Client -> server messages are JSON:
 *   { type: "input", data }  |  { type: "resize", cols, rows }
 * Server -> client messages are raw terminal output strings, plus a JSON
 * { type: "exit", code } frame when the shell ends.
 */
export function attachTerminal(ws: WebSocket): void {
  const shell = process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "bash");
  const proc = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: WORKSPACE_ROOT,
    env: cleanEnv({ TERM: "xterm-256color", BCODE: "1" }) as Record<string, string>,
  });
  const session: Session = { proc, ws };

  proc.onData((data) => {
    if (session.ws.readyState === WebSocket.OPEN) session.ws.send(data);
  });
  proc.onExit(({ exitCode }) => {
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: "exit", code: exitCode }));
      session.ws.close();
    }
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "input" && typeof msg.data === "string") {
        proc.write(msg.data);
      } else if (msg.type === "resize") {
        const cols = Math.max(2, Math.min(500, Number(msg.cols) || 80));
        const rows = Math.max(2, Math.min(200, Number(msg.rows) || 24));
        proc.resize(cols, rows);
      }
    } catch {
      /* ignore malformed frames */
    }
  });

  const cleanup = () => {
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}
