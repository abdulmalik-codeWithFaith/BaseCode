import { useCallback, useEffect, useRef, useState } from "react";
import { api, type TreeNode } from "./api";
import FileExplorer from "./components/FileExplorer";
import SearchPanel from "./components/SearchPanel";
import GitPanel from "./components/GitPanel";
import DiffModal from "./components/DiffModal";
import AgentPanel from "./components/AgentPanel";
import CodeEditor, { type Buffer } from "./components/CodeEditor";
import TerminalPanel from "./components/TerminalPanel";
import PreviewPane from "./components/PreviewPane";
import { useSplit } from "./useSplit";

type SidebarView = "files" | "search" | "git";

export default function App() {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [projectName, setProjectName] = useState("workspace");
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
  const [revealLine, setRevealLine] = useState<{ path: string; line: number; nonce: number } | null>(null);

  const [sidebarView, setSidebarView] = useState<SidebarView>("files");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [agentOpen, setAgentOpen] = useState(true);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [diffPath, setDiffPath] = useState<string | null>(null);

  const [terminals, setTerminals] = useState<number[]>([1]);
  const [activeTerm, setActiveTerm] = useState(1);
  const nextTermId = useRef(2);

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>();

  const [sidebarW, onSidebarDrag] = useSplit(250, 160, 520, "x");
  const [previewW, onPreviewDrag] = useSplit(440, 260, 1100, "x", true);
  const [terminalH, onTerminalDrag] = useSplit(260, 100, 700, "y", true);
  const [agentW, onAgentDrag] = useSplit(380, 280, 800, "x", true);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  const refreshTree = useCallback(async () => {
    try {
      const t = await api.tree();
      setTree(t.children);
      setProjectName(t.name);
    } catch (e) {
      notify(`Could not load files: ${(e as Error).message}`);
    }
  }, [notify]);

  useEffect(() => {
    refreshTree();
  }, [refreshTree]);

  const openFile = useCallback(
    async (path: string, line?: number) => {
      if (!buffers[path]) {
        try {
          const f = await api.readFile(path);
          setBuffers((b) => ({ ...b, [path]: { content: f.content, original: f.content } }));
        } catch (e) {
          notify(`Cannot open ${path}: ${(e as Error).message}`);
          return;
        }
      }
      setOpenPaths((p) => (p.includes(path) ? p : [...p, path]));
      setActivePath(path);
      if (line) setRevealLine({ path, line, nonce: Date.now() });
    },
    [buffers, notify],
  );

  const closeFile = useCallback(
    (path: string) => {
      const b = buffers[path];
      if (b && b.content !== b.original && !window.confirm(`Discard unsaved changes to ${path}?`)) return;
      setOpenPaths((paths) => {
        const idx = paths.indexOf(path);
        const next = paths.filter((p) => p !== path);
        setActivePath((cur) => (cur === path ? (next[Math.min(idx, next.length - 1)] ?? null) : cur));
        return next;
      });
      setBuffers((all) => {
        const { [path]: _drop, ...rest } = all;
        return rest;
      });
    },
    [buffers],
  );

  const changeBuffer = useCallback((path: string, content: string) => {
    setBuffers((b) => (b[path] ? { ...b, [path]: { ...b[path], content } } : b));
  }, []);

  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;
  const activeRef = useRef(activePath);
  activeRef.current = activePath;

    /**
   * Re-sync the UI with the disk after something outside the editor changed files
   * (git discard / checkout / pull). Unsaved edits are never overwritten.
   */
  const syncFromDisk = useCallback(async () => {
    await refreshTree();
    for (const [path, b] of Object.entries(buffersRef.current)) {
      if (b.content !== b.original) continue; // keep the user's unsaved edits
      try {
        const f = await api.readFile(path);
        if (f.content !== b.original) {
          setBuffers((all) =>
            all[path] && all[path].content === all[path].original ? { ...all, [path]: { content: f.content, original: f.content } } : all,
          );
        }
      } catch {
        // File no longer exists on disk: close its tab.
        setOpenPaths((ps) => ps.filter((p) => p !== path));
        setBuffers((all) => Object.fromEntries(Object.entries(all).filter(([p]) => p !== path)));
        setActivePath((cur) => (cur === path ? null : cur));
      }
    }
    setPreviewNonce((n) => n + 1);
  }, [refreshTree]);

  const saveActive = useCallback(async () => {
    const path = activeRef.current;
    if (!path) return;
    const buf = buffersRef.current[path];
    if (!buf) return;
    try {
      await api.writeFile(path, buf.content);
      setBuffers((b) => (b[path] ? { ...b, [path]: { ...b[path], original: buf.content } } : b));
      setPreviewNonce((n) => n + 1);
    } catch (e) {
      notify(`Save failed: ${(e as Error).message}`);
    }
  }, [notify]);

  const createEntry = useCallback(
    async (path: string, type: "file" | "dir") => {
      try {
        await api.create(path, type);
        await refreshTree();
        if (type === "file") openFile(path);
      } catch (e) {
        notify((e as Error).message);
      }
    },
    [openFile, refreshTree, notify],
  );

  const renameEntry = useCallback(
    async (from: string, to: string) => {
      try {
        await api.rename(from, to);
        // Close any open tabs under the old path; the user can reopen from the tree.
        setOpenPaths((ps) => ps.filter((p) => p !== from && !p.startsWith(from + "/")));
        setBuffers((all) => Object.fromEntries(Object.entries(all).filter(([p]) => p !== from && !p.startsWith(from + "/"))));
        setActivePath((cur) => (cur && (cur === from || cur.startsWith(from + "/")) ? null : cur));
        await refreshTree();
      } catch (e) {
        notify((e as Error).message);
      }
    },
    [refreshTree, notify],
  );

  const deleteEntry = useCallback(
    async (path: string) => {
      try {
        await api.remove(path);
        setOpenPaths((ps) => ps.filter((p) => p !== path && !p.startsWith(path + "/")));
        setBuffers((all) => Object.fromEntries(Object.entries(all).filter(([p]) => p !== path && !p.startsWith(path + "/"))));
        setActivePath((cur) => (cur && (cur === path || cur.startsWith(path + "/")) ? null : cur));
        await refreshTree();
      } catch (e) {
        notify((e as Error).message);
      }
    },
    [refreshTree, notify],
  );

  const newTerminal = useCallback(() => {
    const id = nextTermId.current++;
    setTerminals((t) => [...t, id]);
    setActiveTerm(id);
    setTerminalOpen(true);
  }, []);

  const killTerminal = useCallback((id: number) => {
    setTerminals((t) => {
      const next = t.filter((x) => x !== id);
      setActiveTerm((cur) => (cur === id ? (next[next.length - 1] ?? 0) : cur));
      if (next.length === 0) setTerminalOpen(false);
      return next;
    });
  }, []);

  // Refresh the file tree when the shell may have changed files (e.g. npm install, git clone).
  useEffect(() => {
    const onFocus = () => refreshTree();
    window.addEventListener("focus", onFocus);
    const iv = window.setInterval(refreshTree, 5000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(iv);
    };
  }, [refreshTree]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "`") {
        e.preventDefault();
        if (terminals.length === 0) newTerminal();
        else setTerminalOpen((o) => !o);
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarOpen((o) => !o);
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveActive();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [terminals.length, newTerminal, saveActive]);

  const dirtyCount = Object.values(buffers).filter((b) => b.content !== b.original).length;

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirtyCount > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirtyCount]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">B</span> Code
        </div>
        <div className="project-name">{projectName}</div>
        <div className="topbar-actions">
          <button onClick={saveActive} disabled={!activePath} title="Ctrl+S">
            Save
          </button>
          <button className={previewOpen ? "on" : ""} onClick={() => setPreviewOpen((o) => !o)}>
            Preview
          </button>
          <button
            className={terminalOpen ? "on" : ""}
            onClick={() => (terminals.length === 0 ? newTerminal() : setTerminalOpen((o) => !o))}
          >
            Terminal
          </button>
            <button className={agentOpen ? "on" : ""} onClick={() => setAgentOpen((o) => !o)}>
            AI Agent
          </button>
        </div>
      </header>

      <div className="body">
        <nav className="activity-bar">
          <button
            className={sidebarOpen && sidebarView === "files" ? "active" : ""}
            title="Explorer"
            onClick={() => {
              if (sidebarView === "files") setSidebarOpen((o) => !o);
              else {
                setSidebarView("files");
                setSidebarOpen(true);
              }
            }}
          >
            ▤
          </button>
          <button
            className={sidebarOpen && sidebarView === "search" ? "active" : ""}
            title="Search"
            onClick={() => {
              if (sidebarView === "search") setSidebarOpen((o) => !o);
              else {
                setSidebarView("search");
                setSidebarOpen(true);
              }
            }}
          >
            ⌕
          </button>
                    <button
            className={sidebarOpen && sidebarView === "git" ? "active" : ""}
            title="Source Control"
            onClick={() => {
              if (sidebarView === "git") setSidebarOpen((o) => !o);
              else {
                setSidebarView("git");
                setSidebarOpen(true);
              }
            }}
          >
            ⑂
          </button>
        </nav>

        {sidebarOpen && (
          <>
            <aside className="sidebar" style={{ width: sidebarW }}>
              {sidebarView === "files" ? (
                <FileExplorer
                  nodes={tree}
                  activePath={activePath}
                  onOpen={(p) => openFile(p)}
                  onCreate={createEntry}
                  onRename={renameEntry}
                  onDelete={deleteEntry}
                />
                ) : sidebarView === "search" ? (
                <SearchPanel onOpen={openFile} />
              ) : (
                <GitPanel refreshKey={previewNonce} onOpenDiff={setDiffPath} onFilesChanged={syncFromDisk} />
              )}
            </aside>
            <div className="splitter splitter-x" onMouseDown={onSidebarDrag} />
          </>
        )}

        <main className="main">
          <div className="main-top">
            <div className="editor-col">
              <CodeEditor
                openPaths={openPaths}
                activePath={activePath}
                buffers={buffers}
                revealLine={revealLine}
                onSelect={setActivePath}
                onClose={closeFile}
                onChange={changeBuffer}
                onSave={saveActive}
              />
            </div>
            {previewOpen && (
              <>
                <div className="splitter splitter-x" onMouseDown={onPreviewDrag} />
                <div className="preview-col" style={{ width: previewW }}>
                  <PreviewPane reloadNonce={previewNonce} onClose={() => setPreviewOpen(false)} />
                </div>
              </>
            )}
          </div>

          {terminals.length > 0 && (
            <>
              {terminalOpen && <div className="splitter splitter-y" onMouseDown={onTerminalDrag} />}
              <div className="terminal-wrap" style={{ height: terminalOpen ? terminalH : 0, display: terminalOpen ? "block" : "none" }}>
                <TerminalPanel
                  terminals={terminals}
                  activeId={activeTerm}
                  visible={terminalOpen}
                  onSelect={setActiveTerm}
                  onNew={newTerminal}
                  onKill={killTerminal}
                  onHide={() => setTerminalOpen(false)}
                />
              </div>
            </>
          )}
        </main>
                {agentOpen && (
          <>
            <div className="splitter splitter-x" onMouseDown={onAgentDrag} />
            <aside className="agent-col" style={{ width: agentW }}>
              <AgentPanel onFilesChanged={syncFromDisk} onClose={() => setAgentOpen(false)} />
            </aside>
          </>
        )}
      </div>

      <footer className="statusbar">
        <span>{activePath ?? "No file open"}</span>
        <span>{dirtyCount > 0 ? `${dirtyCount} unsaved` : "All changes saved"}</span>
      </footer>
      {diffPath && <DiffModal path={diffPath} onClose={() => setDiffPath(null)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
