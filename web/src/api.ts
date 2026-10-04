export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

const q = (p: string) => encodeURIComponent(p);

export const api = {
  tree: () => request<{ name: string; children: TreeNode[] }>("/api/tree"),
  readFile: (path: string) => request<{ path: string; content: string }>(`/api/file?path=${q(path)}`),
  writeFile: (path: string, content: string) =>
    request<{ ok: true }>("/api/file", { method: "PUT", body: JSON.stringify({ path, content }) }),
  create: (path: string, type: "file" | "dir") =>
    request<{ ok: true }>("/api/entry", { method: "POST", body: JSON.stringify({ path, type }) }),
  remove: (path: string) => request<{ ok: true }>(`/api/entry?path=${q(path)}`, { method: "DELETE" }),
  rename: (from: string, to: string) =>
    request<{ ok: true }>("/api/rename", { method: "POST", body: JSON.stringify({ from, to }) }),
  search: (query: string) => request<{ hits: SearchHit[] }>(`/api/search?q=${q(query)}`),
};

export function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

// ---------- Git ----------

export interface GitFile {
  path: string;
  index: string; // staged status letter, " " = none, "?" = untracked
  worktree: string; // unstaged status letter, " " = none, "?" = untracked
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  branches: string[];
  truncated: boolean;
}

export interface GitCommit {
  hash: string;
  author: string;
  when: string;
  subject: string;
}

const post = <T = { ok: true }>(url: string, body: unknown = {}) =>
  request<T>(url, { method: "POST", body: JSON.stringify(body) });

export const git = {
  status: () => request<GitStatus>("/api/git/status"),
  init: () => post("/api/git/init"),
  stage: (paths: string[]) => post("/api/git/stage", { paths }),
  unstage: (paths: string[]) => post("/api/git/unstage", { paths }),
  discard: (paths: string[]) => post("/api/git/discard", { paths }),
  commit: (message: string) => post("/api/git/commit", { message }),
  checkout: (branch: string, create = false) => post("/api/git/checkout", { branch, create }),
  push: () => post("/api/git/push"),
  pull: () => post<{ ok: true; message: string }>("/api/git/pull"),
  log: () => request<{ commits: GitCommit[] }>("/api/git/log"),
  show: (path: string) => request<{ exists: boolean; content: string }>(`/api/git/show?path=${q(path)}`),
};

// ---------- AI agent ----------

export interface AgentStatus {
  provider: string;
  model: string;
  configured: boolean;
}

export const agent = {
  status: () => request<AgentStatus>("/api/agent/status"),
};

/** Events sent by the server over /ws/agent. */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "approval_request"; id: string; name: string; args: Record<string, unknown>; dangerous: boolean }
  | { type: "tool_result"; id: string; name: string; status: "ok" | "error" | "denied"; summary: string; changed: boolean }
  | { type: "done"; steps: number }
  | { type: "stopped" }
  | { type: "error"; message: string; code?: string };