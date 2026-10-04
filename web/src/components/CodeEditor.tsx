import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";

type StandaloneEditor = Parameters<OnMount>[0];

export interface Buffer {
  content: string;
  original: string;
}

interface Props {
  openPaths: string[];
  activePath: string | null;
  buffers: Record<string, Buffer>;
  revealLine?: { path: string; line: number; nonce: number } | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onChange: (path: string, content: string) => void;
  onSave: () => void;
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  py: "python",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  go: "go",
  rs: "rust",
  php: "php",
  sh: "shell",
  bash: "shell",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  sql: "sql",
  rb: "ruby",
  toml: "ini",
};

export function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext] ?? "plaintext";
}

const basename = (p: string) => p.split("/").pop() ?? p;

export default function CodeEditor({
  openPaths,
  activePath,
  buffers,
  revealLine,
  onSelect,
  onClose,
  onChange,
  onSave,
}: Props) {
  const editorRef = useRef<StandaloneEditor | null>(null);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
  };

  useEffect(() => {
    if (revealLine && editorRef.current && revealLine.path === activePath) {
      editorRef.current.revealLineInCenter(revealLine.line);
      editorRef.current.setPosition({ lineNumber: revealLine.line, column: 1 });
      editorRef.current.focus();
    }
  }, [revealLine, activePath]);

  const active = activePath ? buffers[activePath] : null;

  return (
    <div className="editor-area">
      <div className="tabs">
        {openPaths.map((p) => {
          const b = buffers[p];
          const dirty = b && b.content !== b.original;
          return (
            <div
              key={p}
              className={`tab${p === activePath ? " active" : ""}`}
              title={p}
              onClick={() => onSelect(p)}
              onAuxClick={(e) => e.button === 1 && onClose(p)}
            >
              <span>{basename(p)}</span>
              <button
                className={`tab-close${dirty ? " dirty" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(p);
                }}
                title={dirty ? "Unsaved changes — close" : "Close"}
              >
                {dirty ? "●" : "✕"}
              </button>
            </div>
          );
        })}
      </div>
      <div className="editor-host">
        {activePath && active ? (
          <Editor
            height="100%"
            theme="bcode-dark"
            path={activePath}
            language={languageFor(activePath)}
            value={active.content}
            onChange={(v) => onChange(activePath, v ?? "")}
            onMount={handleMount}
            options={{
              fontSize: 14,
              minimap: { enabled: true },
              automaticLayout: true,
              scrollBeyondLastLine: false,
              tabSize: 2,
              fontLigatures: true,
              smoothScrolling: true,
              formatOnPaste: true,
            }}
          />
        ) : (
          <div className="welcome">
            <h1>B Code</h1>
            <p>Open a file from the explorer to start coding.</p>
            <ul>
              <li>
                <kbd>Ctrl</kbd>+<kbd>S</kbd> save
              </li>
              <li>
                <kbd>Ctrl</kbd>+<kbd>`</kbd> toggle terminal
              </li>
              <li>
                <kbd>Ctrl</kbd>+<kbd>B</kbd> toggle sidebar
              </li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
