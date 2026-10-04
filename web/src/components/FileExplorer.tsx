import { useState } from "react";
import type { TreeNode } from "../api";

interface Props {
  nodes: TreeNode[];
  activePath: string | null;
  onOpen: (path: string) => void;
  onCreate: (path: string, type: "file" | "dir") => void;
  onRename: (from: string, to: string) => void;
  onDelete: (path: string) => void;
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export default function FileExplorer({ nodes, activePath, onOpen, onCreate, onRename, onDelete }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedDir, setSelectedDir] = useState("");

  const toggle = (p: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const baseDir = () => selectedDir;

  const promptCreate = (type: "file" | "dir") => {
    const dir = baseDir();
    const name = window.prompt(type === "file" ? "New file name" : "New folder name", "");
    if (!name?.trim()) return;
    const clean = name.trim().replace(/^\/+/, "");
    setExpanded((prev) => new Set(prev).add(dir));
    onCreate(join(dir, clean), type);
  };

  const renderNodes = (list: TreeNode[], depth: number): React.ReactNode =>
    list.map((n) => {
      const isDir = n.type === "dir";
      const open = expanded.has(n.path);
      const active = !isDir && n.path === activePath;
      return (
        <div key={n.path}>
          <div
            className={`tree-row${active ? " active" : ""}${isDir && selectedDir === n.path ? " selected" : ""}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => {
              if (isDir) {
                toggle(n.path);
                setSelectedDir(n.path);
              } else {
                setSelectedDir(parentOf(n.path));
                onOpen(n.path);
              }
            }}
          >
            <span className="tree-icon">{isDir ? (open ? "▾" : "▸") : "·"}</span>
            <span className="tree-name">{n.name}</span>
            <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
              <button
                title="Rename"
                onClick={() => {
                  const to = window.prompt("Rename to", n.name);
                  if (to?.trim() && to.trim() !== n.name) onRename(n.path, join(parentOf(n.path), to.trim()));
                }}
              >
                ✎
              </button>
              <button
                title="Delete"
                onClick={() => {
                  if (window.confirm(`Delete ${n.path}${isDir ? " and everything in it" : ""}?`)) onDelete(n.path);
                }}
              >
                ✕
              </button>
            </span>
          </div>
          {isDir && open && n.children && renderNodes(n.children, depth + 1)}
        </div>
      );
    });

  return (
    <div className="explorer">
      <div className="panel-header">
        <span>EXPLORER</span>
        <span className="header-actions">
          <button title="New file" onClick={() => promptCreate("file")}>
            + File
          </button>
          <button title="New folder" onClick={() => promptCreate("dir")}>
            + Folder
          </button>
        </span>
      </div>
      <div
        className="tree"
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelectedDir("");
        }}
      >
        {nodes.length === 0 ? <div className="empty-note">Workspace is empty</div> : renderNodes(nodes, 0)}
      </div>
    </div>
  );
}
