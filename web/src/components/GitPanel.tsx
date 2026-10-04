import { useCallback, useEffect, useRef, useState } from "react";
import { git, type GitCommit, type GitFile, type GitStatus } from "../api";

interface Props {
  /** Bump to force a status refresh (e.g. after saving a file). */
  refreshKey: number;
  onOpenDiff: (path: string) => void;
  /** Called after an action that may change files on disk (discard, checkout, pull...). */
  onFilesChanged: () => void;
}

const LABEL: Record<string, string> = { M: "M", A: "A", D: "D", R: "R", C: "C", T: "T", U: "U", "?": "U" };

const isStaged = (f: GitFile) => f.index !== " " && f.index !== "?";
const isUnstaged = (f: GitFile) => f.worktree !== " " || f.index === "?";

function Badge({ letter }: { letter: string }) {
  return <span className={`git-badge git-${letter === "?" ? "U" : letter}`}>{LABEL[letter] ?? letter}</span>;
}

export default function GitPanel({ refreshKey, onOpenDiff, onFilesChanged }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [showLog, setShowLog] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const load = useCallback(async () => {
    try {
      const s = await git.status();
      setStatus(s);
      if (s.isRepo) setCommits((await git.log()).commits);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useEffect(() => {
    const iv = window.setInterval(() => {
      if (!busyRef.current) load();
    }, 4000);
    return () => window.clearInterval(iv);
  }, [load]);

  const run = async (fn: () => Promise<unknown>, opts: { filesChanged?: boolean; okMessage?: string } = {}) => {
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const result = await fn();
      if (opts.okMessage) setInfo(opts.okMessage);
      else if (result && typeof result === "object" && "message" in result) setInfo(String((result as { message: string }).message));
      await load();
      if (opts.filesChanged) onFilesChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <div className="explorer">
        <div className="panel-header">
          <span>SOURCE CONTROL</span>
        </div>
        <div className="empty-note">{error || "Loading…"}</div>
      </div>
    );
  }

  if (!status.isRepo) {
    return (
      <div className="explorer">
        <div className="panel-header">
          <span>SOURCE CONTROL</span>
        </div>
        <div className="git-empty">
          <p>This project is not a Git repository yet.</p>
          <button className="git-primary" disabled={busy} onClick={() => run(() => git.init(), { filesChanged: true })}>
            Initialize repository
          </button>
          {error && <div className="git-msg error">{error}</div>}
        </div>
      </div>
    );
  }

  const staged = status.files.filter(isStaged);
  const changes = status.files.filter(isUnstaged);
  const canCommit = staged.length > 0 && message.trim().length > 0 && !busy;

  const commit = () => {
    if (!canCommit) return;
    run(async () => {
      await git.commit(message.trim());
      setMessage("");
    }, { okMessage: "Committed" });
  };

  const onBranchChange = (value: string) => {
    if (value === "__new__") {
      const name = window.prompt("New branch name (created from the current branch)");
      if (name?.trim()) run(() => git.checkout(name.trim(), true), { filesChanged: true, okMessage: `Switched to ${name.trim()}` });
    } else if (value && value !== status.branch) {
      run(() => git.checkout(value), { filesChanged: true, okMessage: `Switched to ${value}` });
    }
  };

  const row = (f: GitFile, side: "staged" | "changes") => {
    const letter = side === "staged" ? f.index : f.index === "?" ? "?" : f.worktree;
    const name = f.path.split("/").pop() ?? f.path;
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    return (
      <div key={`${side}:${f.path}`} className="git-row" onClick={() => onOpenDiff(f.path)} title={f.path}>
        <span className="git-file">
          {name} {dir && <span className="git-dir">{dir}</span>}
        </span>
        <span className="git-row-actions" onClick={(e) => e.stopPropagation()}>
          {side === "changes" && (
            <button
              title={f.index === "?" ? "Delete this new file" : "Discard changes"}
              disabled={busy}
              onClick={() => {
                const msg = f.index === "?" ? `Delete ${f.path}? This cannot be undone.` : `Discard changes to ${f.path}? This cannot be undone.`;
                if (window.confirm(msg)) run(() => git.discard([f.path]), { filesChanged: true });
              }}
            >
              ↶
            </button>
          )}
          <button
            title={side === "staged" ? "Unstage" : "Stage"}
            disabled={busy}
            onClick={() => run(() => (side === "staged" ? git.unstage([f.path]) : git.stage([f.path])))}
          >
            {side === "staged" ? "−" : "+"}
          </button>
        </span>
        <Badge letter={letter} />
      </div>
    );
  };

  return (
    <div className="explorer git-panel">
      <div className="panel-header">
        <span>SOURCE CONTROL</span>
        <span className="header-actions">
          <button title="Refresh" onClick={() => run(async () => undefined)}>
            ⟳
          </button>
        </span>
      </div>

      <div className="git-scroll">
        <div className="git-branch-row">
          <select value={status.branch ?? ""} disabled={busy} onChange={(e) => onBranchChange(e.target.value)}>
            {status.branch && !status.branches.includes(status.branch) && <option value={status.branch}>{status.branch}</option>}
            {status.branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
            <option value="__new__">＋ New branch…</option>
          </select>
          <button
            title={status.upstream ? `Pull from ${status.upstream}` : "No upstream branch to pull from"}
            disabled={busy || !status.upstream}
            onClick={() => run(() => git.pull(), { filesChanged: true })}
          >
            ↓{status.behind > 0 ? ` ${status.behind}` : ""}
          </button>
          <button
            title={status.upstream ? `Push to ${status.upstream}` : "Push and set upstream (origin)"}
            disabled={busy || commits.length === 0}
            onClick={() => run(() => git.push(), { okMessage: "Pushed" })}
          >
            ↑{status.ahead > 0 ? ` ${status.ahead}` : ""}
          </button>
        </div>

        <div className="git-commit-box">
          <textarea
            value={message}
            placeholder="Commit message (Ctrl+Enter to commit)"
            rows={3}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") commit();
            }}
          />
          <button className="git-primary" disabled={!canCommit} onClick={commit}>
            Commit{staged.length > 0 ? ` (${staged.length})` : ""}
          </button>
        </div>

        {error && <div className="git-msg error">{error}</div>}
        {info && !error && <div className="git-msg">{info}</div>}

        <div className="git-section">
          <div className="git-section-head">
            <span>
              Staged Changes <span className="badge">{staged.length}</span>
            </span>
            {staged.length > 0 && (
              <button title="Unstage all" disabled={busy} onClick={() => run(() => git.unstage(staged.map((f) => f.path)))}>
                −
              </button>
            )}
          </div>
          {staged.map((f) => row(f, "staged"))}
        </div>

        <div className="git-section">
          <div className="git-section-head">
            <span>
              Changes <span className="badge">{changes.length}</span>
            </span>
            {changes.length > 0 && (
              <button title="Stage all" disabled={busy} onClick={() => run(() => git.stage(changes.map((f) => f.path)))}>
                +
              </button>
            )}
          </div>
          {changes.map((f) => row(f, "changes"))}
          {status.truncated && <div className="empty-note">Too many changes to list. Add a .gitignore.</div>}
          {staged.length === 0 && changes.length === 0 && <div className="empty-note">No changes</div>}
        </div>

        <div className="git-section">
          <div className="git-section-head clickable" onClick={() => setShowLog((s) => !s)}>
            <span>
              {showLog ? "▾" : "▸"} History <span className="badge">{commits.length}</span>
            </span>
          </div>
          {showLog &&
            commits.map((c) => (
              <div key={c.hash} className="git-commit" title={`${c.hash} · ${c.author} · ${c.when}`}>
                <span className="git-hash">{c.hash}</span>
                <span className="git-subject">{c.subject}</span>
                <span className="git-when">{c.when}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}