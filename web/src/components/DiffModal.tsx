import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { api, git } from "../api";
import { languageFor } from "./CodeEditor";

interface Props {
  path: string;
  onClose: () => void;
}

/** Side-by-side diff: last commit (HEAD) on the left, your working copy on the right. */
export default function DiffModal({ path, onClose }: Props) {
  const [original, setOriginal] = useState<string | null>(null);
  const [modified, setModified] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [head, work] = await Promise.all([
          git.show(path),
          api.readFile(path).then((f) => f.content, () => ""), // deleted file -> empty right side
        ]);
        if (cancelled) return;
        setOriginal(head.content);
        setIsNew(!head.exists);
        setModified(work);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>
            {path} <span className="git-dir">{isNew ? "new file" : "HEAD ↔ working copy"}</span>
          </span>
          <button onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
        <div className="modal-body">
          {error ? (
            <div className="empty-note error">{error}</div>
          ) : original === null || modified === null ? (
            <div className="empty-note">Loading diff…</div>
          ) : (
            <DiffEditor
              height="100%"
              theme="bcode-dark"
              language={languageFor(path)}
              original={original}
              modified={modified}
              options={{ readOnly: true, renderSideBySide: true, automaticLayout: true, minimap: { enabled: false } }}
            />
          )}
        </div>
      </div>
    </div>
  );
}