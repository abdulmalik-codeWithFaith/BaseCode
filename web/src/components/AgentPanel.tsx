import { useCallback, useEffect, useRef, useState } from "react";
import { agent, wsUrl, type AgentEvent, type AgentStatus } from "../api";

interface Props {
  /** Called (debounced) when the agent may have changed files, so the UI can re-sync with the disk. */
  onFilesChanged: () => void;
  onClose: () => void;
}

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: Record<string, unknown>;
      status: "running" | "waiting" | "ok" | "error" | "denied";
      summary?: string;
      dangerous?: boolean;
    }
  | { kind: "error"; text: string }
  | { kind: "note"; text: string };

const AUTO_KEY = "bcode.agent.autoApprove";

function readAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) === "1";
  } catch {
    return false;
  }
}

function describeTool(name: string, args: Record<string, unknown>): string {
  const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  switch (name) {
    case "list_files":
      return `List ${s("path") || "."}`;
    case "read_file":
      return `Read ${s("path")}`;
    case "write_file":
      return `Write ${s("path")}`;
    case "edit_file":
      return `Edit ${s("path")}`;
    case "delete_file":
      return `Delete ${s("path")}`;
    case "search_code":
      return `Search "${s("query")}"`;
    case "run_command":
      return `$ ${s("command")}`;
    case "git_status":
      return "Git status";
    case "git_diff":
      return `Git diff ${s("path")}`.trim();
    case "git_commit":
      return `Git commit: ${s("message")}`;
    default:
      return name;
  }
}

/** Renders ```fenced``` blocks as code and everything else as plain text. */
function RichText({ text }: { text: string }) {
  const chunks = text.split(/```/);
  return (
    <>
      {chunks.map((chunk, i) => {
        if (i % 2 === 1) {
          const code = chunk.replace(/^[a-zA-Z0-9_+-]*\n/, "");
          return (
            <pre key={i} className="agent-code">
              {code.replace(/\n$/, "")}
            </pre>
          );
        }
        return chunk ? (
          <span key={i} className="agent-prose">
            {chunk}
          </span>
        ) : null;
      })}
    </>
  );
}

export default function AgentPanel({ onFilesChanged, onClose }: Props) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [autoApprove, setAutoApprove] = useState(readAuto);

  const wsRef = useRef<WebSocket | null>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const bottomRef = useRef<HTMLDivElement>(null);
  const changeTimer = useRef<number>();
  const onChangedRef = useRef(onFilesChanged);
  onChangedRef.current = onFilesChanged;

  const filesChanged = useCallback(() => {
    window.clearTimeout(changeTimer.current);
    changeTimer.current = window.setTimeout(() => onChangedRef.current(), 400);
  }, []);

  const loadStatus = useCallback(() => {
    agent.status().then(setStatus, () => setStatus({ provider: "gemini", model: "", configured: false }));
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleEvent = useCallback(
    (ev: AgentEvent) => {
      switch (ev.type) {
        case "text":
          setItems((it) => [...it, { kind: "assistant", text: ev.text }]);
          break;
        case "tool_call":
          setItems((it) => [...it, { kind: "tool", id: ev.id, name: ev.name, args: ev.args, status: "running" }]);
          break;
        case "approval_request":
          setItems((it) => it.map((x) => (x.kind === "tool" && x.id === ev.id ? { ...x, status: "waiting", dangerous: ev.dangerous } : x)));
          break;
        case "tool_result":
          setItems((it) => it.map((x) => (x.kind === "tool" && x.id === ev.id ? { ...x, status: ev.status, summary: ev.summary } : x)));
          if (ev.changed) filesChanged();
          break;
        case "done":
          setBusy(false);
          filesChanged();
          break;
        case "stopped":
          setBusy(false);
          setItems((it) => [...it, { kind: "note", text: "Stopped." }]);
          filesChanged();
          break;
        case "error":
          setBusy(false);
          setItems((it) => [...it, { kind: "error", text: ev.message }]);
          if (ev.code === "no_key" || ev.code === "bad_key") loadStatus();
          filesChanged();
          break;
      }
    },
    [filesChanged, loadStatus],
  );

  // One WebSocket for the lifetime of the panel, reconnecting if it drops.
  useEffect(() => {
    let closed = false;
    let retry: number | undefined;

    const connect = () => {
      const ws = new WebSocket(wsUrl("/ws/agent"));
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (m) => {
        try {
          handleEvent(JSON.parse(m.data as string) as AgentEvent);
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (busyRef.current) {
          setBusy(false);
          setItems((it) => [...it, { kind: "error", text: "Lost the connection to the server while the agent was working." }]);
        }
        if (!closed) retry = window.setTimeout(connect, 1500);
      };
    };
    connect();

    return () => {
      closed = true;
      window.clearTimeout(retry);
      window.clearTimeout(changeTimer.current);
      wsRef.current?.close();
    };
  }, [handleEvent]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [items]);

  const send = (payload: object) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  };

  const submit = () => {
    const text = input.trim();
    if (!text || busy || !connected) return;
    if (send({ type: "user", text, autoApprove })) {
      setItems((it) => [...it, { kind: "user", text }]);
      setInput("");
      setBusy(true);
    }
  };

  const decide = (id: string, allow: boolean) => {
    send({ type: "approve", id, allow });
    setItems((it) => it.map((x) => (x.kind === "tool" && x.id === id ? { ...x, status: allow ? "running" : "denied", summary: allow ? undefined : "Denied" } : x)));
  };

  const toggleAuto = () => {
    if (!autoApprove && !window.confirm("Let the agent delete files, make commits and run commands without asking each time?\n\nCommands that look dangerous (rm -rf, sudo, git push, ...) will still ask. Only turn this on for projects you trust the agent with.")) {
      return;
    }
    const next = !autoApprove;
    setAutoApprove(next);
    try {
      localStorage.setItem(AUTO_KEY, next ? "1" : "0");
    } catch {
      /* private mode: setting just won't persist */
    }
  };

  const reset = () => {
    send({ type: "reset" });
    setItems([]);
    setBusy(false);
  };

  const setup = status && !status.configured;

  return (
    <div className="agent-panel">
      <div className="panel-header">
        <span>AI AGENT{status?.model ? ` · ${status.model}` : ""}</span>
        <span className="header-actions">
          <button title="New conversation" onClick={reset} disabled={items.length === 0 && !busy}>
            ＋ New
          </button>
          <button title="Close" onClick={onClose}>
            ✕
          </button>
        </span>
      </div>

      <div className="agent-scroll">
        {setup && (
          <div className="agent-setup">
            <strong>Connect Gemini to start</strong>
            <ol>
              <li>
                Get a free API key at <code>aistudio.google.com/apikey</code>
              </li>
              <li>
                Create a file named <code>.env</code> inside the <code>server</code> folder with this line:
                <pre className="agent-code">GEMINI_API_KEY=paste-your-key-here</pre>
              </li>
              <li>Restart the server (stop it and run npm run dev again)</li>
            </ol>
            <button className="git-primary" onClick={loadStatus}>
              I did this, check again
            </button>
          </div>
        )}

        {!setup && items.length === 0 && (
          <div className="agent-empty">
            <p>Ask me to build or change something in this project.</p>
            <ul>
              <li>“Build a landing page for a fintech startup”</li>
              <li>“Why is my build failing? Fix it.”</li>
              <li>“Add a dark mode toggle”</li>
            </ul>
          </div>
        )}

        {items.map((item, i) => {
          switch (item.kind) {
            case "user":
              return (
                <div key={i} className="agent-msg user">
                  {item.text}
                </div>
              );
            case "assistant":
              return (
                <div key={i} className="agent-msg assistant">
                  <RichText text={item.text} />
                </div>
              );
            case "error":
              return (
                <div key={i} className="agent-msg error">
                  {item.text}
                </div>
              );
            case "note":
              return (
                <div key={i} className="agent-note">
                  {item.text}
                </div>
              );
            case "tool":
              return (
                <div key={item.id} className={`agent-tool ${item.status}${item.dangerous ? " dangerous" : ""}`}>
                  <div className="agent-tool-head">
                    <span className="agent-tool-state">
                      {item.status === "running" ? "…" : item.status === "waiting" ? "?" : item.status === "ok" ? "✓" : item.status === "denied" ? "⊘" : "!"}
                    </span>
                    <span className="agent-tool-label" title={describeTool(item.name, item.args)}>
                      {describeTool(item.name, item.args)}
                    </span>
                    {item.summary && item.status !== "waiting" && <span className="agent-tool-summary">{item.summary}</span>}
                  </div>
                  {item.status === "waiting" && (
                    <div className="agent-approval">
                      <div className="agent-approval-text">
                        {item.dangerous ? "⚠ This command looks dangerous. " : ""}
                        The agent wants to {item.name === "run_command" ? "run this command" : item.name === "delete_file" ? "delete this" : "commit these changes"}.
                      </div>
                      {item.name === "git_commit" && typeof item.args.message === "string" && <pre className="agent-code">{item.args.message}</pre>}
                      <div className="agent-approval-actions">
                        <button className="allow" onClick={() => decide(item.id, true)}>
                          Allow
                        </button>
                        <button className="deny" onClick={() => decide(item.id, false)}>
                          Deny
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
          }
        })}

        {busy && <div className="agent-note thinking">Working…</div>}
        <div ref={bottomRef} />
      </div>

      <div className="agent-input">
        <textarea
          value={input}
          rows={3}
          placeholder={setup ? "Add your Gemini key first" : connected ? "Ask the agent… (Enter to send, Shift+Enter for a new line)" : "Connecting to the server…"}
          disabled={!!setup}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="agent-input-row">
          <label className="agent-auto" title="Skip approval prompts for deletes, commits and ordinary commands">
            <input type="checkbox" checked={autoApprove} onChange={toggleAuto} /> Auto-approve
          </label>
          {busy ? (
            <button className="agent-stop" onClick={() => send({ type: "stop" })}>
              ■ Stop
            </button>
          ) : (
            <button className="git-primary agent-send" disabled={!input.trim() || !connected || !!setup} onClick={submit}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}