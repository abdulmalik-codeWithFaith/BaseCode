import { WORKSPACE_ROOT, listTree, type TreeNode } from "../workspace.js";
import { AgentError, createProvider } from "./provider.js";
import { TOOL_SPECS, approvalFor, executeTool } from "./tools.js";
import type { AgentEvent, Message, Part } from "./types.js";

const MAX_STEPS = 25;
const MAX_HISTORY_MESSAGES = 80;

function treeLines(nodes: TreeNode[], depth: number, out: string[], limit: number): void {
  for (const n of nodes) {
    if (out.length >= limit) return;
    out.push(`${"  ".repeat(depth)}${n.name}${n.type === "dir" ? "/" : ""}`);
    if (n.type === "dir" && n.children && depth < 2) treeLines(n.children, depth + 1, out, limit);
  }
}

/** Context manager: the system prompt, including a fresh snapshot of the project structure. */
async function buildSystem(): Promise<string> {
  const lines: string[] = [];
  treeLines(await listTree(), 0, lines, 120);
  return `You are the AI agent inside B Code, a code editor. You work directly in the user's project using your tools.

How to work:
- Explore before you change things: use list_files, search_code and read_file to understand the project and follow its existing conventions.
- Make real changes with write_file and edit_file instead of pasting code into the chat. Prefer edit_file for small changes; read the file first so old_string matches exactly.
- After changing code, verify it when sensible (for example run the build or tests with run_command) and fix any errors you find.
- Never start long-running processes such as dev servers or watchers; tell the user to run those in their own terminal.
- Some actions need the user's approval. If the user denies one, do not try to do the same thing another way; ask what they would like instead.
- Do not read, write or reveal secrets (.env files, keys, tokens). The .git folder is off limits.
- Keep replies short. When you finish, summarise what you changed in a few lines.

All paths are relative to the project root. The project root currently contains (first levels only):
${lines.join("\n") || "(empty project)"}

Project root on disk: ${WORKSPACE_ROOT}`;
}

/** Keep the conversation within a sane size without ever leaving a dangling tool result at the front. */
function trimHistory(history: Message[]): void {
  if (history.length <= MAX_HISTORY_MESSAGES) return;
  let cut = history.length - MAX_HISTORY_MESSAGES;
  while (cut < history.length) {
    const m = history[cut];
    if (m.role === "user" && m.parts.some((p) => p.type === "text")) break;
    cut++;
  }
  if (cut < history.length) history.splice(0, cut);
}

function cancelledResult(callId: string, name: string, providerId: string | undefined, reason: string): Part {
  return { type: "tool_result", id: callId, providerId, name, result: { error: reason } };
}

export class AgentSession {
  private history: Message[] = [];
  private abort: AbortController | null = null;
  private running = false;
  private pending = new Map<string, (allow: boolean) => void>();

  constructor(private readonly send: (event: AgentEvent) => void) {}

  get busy(): boolean {
    return this.running;
  }

  async run(text: string, autoApprove: boolean): Promise<void> {
    if (this.running) {
      this.send({ type: "error", message: "The agent is still working on the previous request.", code: "busy" });
      return;
    }
    this.running = true;
    const ac = new AbortController();
    this.abort = ac;
    const userMessage: Message = { role: "user", parts: [{ type: "text", text }] };

    try {
      const provider = createProvider();
      this.history.push(userMessage);
      const system = await buildSystem();

      for (let step = 1; step <= MAX_STEPS; step++) {
        trimHistory(this.history);
        const reply = await provider.generate({ system, messages: this.history, tools: TOOL_SPECS, signal: ac.signal });
        this.history.push({ role: "assistant", parts: reply.parts, raw: reply.raw });

        for (const p of reply.parts) if (p.type === "text") this.send({ type: "text", text: p.text });

        const calls = reply.parts.filter((p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call");
        if (calls.length === 0) {
          this.send({ type: "done", steps: step });
          return;
        }

        const results: Part[] = [];
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i];
          const uiId = `s${step}_${i}`;
          if (ac.signal.aborted) {
            results.push(cancelledResult(uiId, call.name, call.providerId, "Cancelled by the user."));
            continue;
          }
          this.send({ type: "tool_call", id: uiId, name: call.name, args: call.args });

          const { approval, dangerous } = approvalFor(call.name, call.args, autoApprove);
          let allowed = true;
          if (approval === "ask") {
            this.send({ type: "approval_request", id: uiId, name: call.name, args: call.args, dangerous });
            allowed = await this.waitForApproval(uiId, ac.signal);
          }

          if (!allowed) {
            const reason = ac.signal.aborted ? "Cancelled by the user." : "The user denied this action.";
            this.send({ type: "tool_result", id: uiId, name: call.name, status: "denied", summary: ac.signal.aborted ? "Cancelled" : "Denied", changed: false });
            results.push(cancelledResult(uiId, call.name, call.providerId, reason));
            continue;
          }

          const outcome = await executeTool(call.name, call.args, ac.signal);
          this.send({ type: "tool_result", id: uiId, name: call.name, status: outcome.ok ? "ok" : "error", summary: outcome.summary, changed: outcome.changed });
          results.push({ type: "tool_result", id: uiId, providerId: call.providerId, name: call.name, result: outcome.result });
        }

        this.history.push({ role: "user", parts: results });
        if (ac.signal.aborted) {
          this.send({ type: "stopped" });
          return;
        }
      }
      this.send({ type: "error", message: `Stopped after ${MAX_STEPS} steps without finishing. Ask me to continue if you want me to keep going.`, code: "step_limit" });
    } catch (err) {
      // A request that never got an answer should not stay in the history (it would be sent twice on retry).
      const last = this.history[this.history.length - 1];
      if (last === userMessage) this.history.pop();

      if (ac.signal.aborted) {
        this.send({ type: "stopped" });
      } else if (err instanceof AgentError) {
        this.send({ type: "error", message: err.message, code: err.code });
      } else {
        console.error("Agent failure:", err);
        this.send({ type: "error", message: `Something went wrong: ${(err as Error).message}`, code: "internal" });
      }
    } finally {
      this.running = false;
      this.abort = null;
      this.resolveAll(false);
    }
  }

  approve(id: string, allow: boolean): void {
    const resolve = this.pending.get(id);
    if (resolve) {
      this.pending.delete(id);
      resolve(allow);
    }
  }

  /** Stop button: cancels the model request, any running command, and any pending approval. */
  stop(): void {
    this.abort?.abort();
    this.resolveAll(false);
  }

  reset(): void {
    this.stop();
    this.history = [];
  }

  dispose(): void {
    this.stop();
  }

  private waitForApproval(id: string, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) return resolve(false);
      this.pending.set(id, resolve);
      signal.addEventListener("abort", () => this.approve(id, false), { once: true });
    });
  }

  private resolveAll(allow: boolean): void {
    for (const id of [...this.pending.keys()]) this.approve(id, allow);
  }
}