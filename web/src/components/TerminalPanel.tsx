import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { wsUrl } from "../api";

interface ViewProps {
  active: boolean;
  visible: boolean;
  onExit: () => void;
}

function TerminalView({ active, visible, onExit }: ViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const host = hostRef.current!;
    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: "#101118", foreground: "#d6d8e5", cursor: "#8f84ff", selectionBackground: "#39406b" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const ws = new WebSocket(wsUrl("/ws/terminal"));
    wsRef.current = ws;

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };
    const doFit = () => {
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        try {
          fit.fit();
          sendResize();
        } catch {
          /* container not measurable yet */
        }
      }
    };

    ws.onopen = () => doFit();
    ws.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      if (data.startsWith('{"type":"exit"')) {
        term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
        onExitRef.current();
        return;
      }
      term.write(data);
    };
    ws.onclose = () => term.write("\r\n\x1b[90m[disconnected]\x1b[0m\r\n");

    const sub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
    });

    const ro = new ResizeObserver(doFit);
    ro.observe(host);

    return () => {
      ro.disconnect();
      sub.dispose();
      ws.close();
      term.dispose();
    };
  }, []);

  useEffect(() => {
    if (active && visible) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
          const t = termRef.current;
          const ws = wsRef.current;
          if (t && ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
          }
          t?.focus();
        } catch {
          /* ignore */
        }
      });
    }
  }, [active, visible]);

  return <div ref={hostRef} className="term-host" style={{ display: active ? "block" : "none" }} />;
}

interface Props {
  terminals: number[];
  activeId: number;
  visible: boolean;
  onSelect: (id: number) => void;
  onNew: () => void;
  onKill: (id: number) => void;
  onHide: () => void;
}

export default function TerminalPanel({ terminals, activeId, visible, onSelect, onNew, onKill, onHide }: Props) {
  return (
    <div className="terminal-panel">
      <div className="panel-header term-header">
        <span className="term-tabs">
          {terminals.map((id, i) => (
            <span
              key={id}
              className={`term-tab${id === activeId ? " active" : ""}`}
              onClick={() => onSelect(id)}
            >
              bash {i + 1}
              <button
                title="Kill terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  onKill(id);
                }}
              >
                ✕
              </button>
            </span>
          ))}
        </span>
        <span className="header-actions">
          <button title="New terminal" onClick={onNew}>
            + New
          </button>
          <button title="Hide panel" onClick={onHide}>
            ▾
          </button>
        </span>
      </div>
      <div className="term-body">
        {terminals.map((id) => (
          <TerminalView key={id} active={id === activeId} visible={visible} onExit={() => onKill(id)} />
        ))}
      </div>
    </div>
  );
}
