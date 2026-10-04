import fs from "node:fs/promises";
import path from "node:path";

export const WORKSPACE_ROOT = path.resolve(
  process.env.BCODE_WORKSPACE ?? path.join(process.cwd(), "..", "workspace"),
);

const IGNORED = new Set([".git", "node_modules", "dist", ".next", ".cache"]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export class WorkspaceError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Resolve a workspace-relative path and guarantee it cannot escape the root. */
export function resolveSafe(rel: string): string {
  const cleaned = rel.replace(/^[/\\]+/, "");
  const abs = path.resolve(WORKSPACE_ROOT, cleaned);
  if (abs !== WORKSPACE_ROOT && !abs.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new WorkspaceError("Path escapes workspace", 403);
  }
  return abs;
}

export function toRel(abs: string): string {
  return path.relative(WORKSPACE_ROOT, abs).split(path.sep).join("/");
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
}

export async function ensureWorkspace(): Promise<void> {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  const entries = await fs.readdir(WORKSPACE_ROOT);
  if (entries.length === 0) {
    await fs.writeFile(
      path.join(WORKSPACE_ROOT, "index.html"),
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>My B Code Project</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <h1>Hello from B Code 👋</h1>
    <p>Edit <code>index.html</code> and save to see the preview update.</p>
    <script src="script.js"></script>
  </body>
</html>
`,
    );
    await fs.writeFile(
      path.join(WORKSPACE_ROOT, "style.css"),
      `body {
  font-family: system-ui, sans-serif;
  max-width: 640px;
  margin: 4rem auto;
  padding: 0 1rem;
}
h1 {
  color: #6d5efc;
}
`,
    );
    await fs.writeFile(
      path.join(WORKSPACE_ROOT, "script.js"),
      `console.log("B Code project loaded");\n`,
    );
    await fs.writeFile(
      path.join(WORKSPACE_ROOT, "README.md"),
      `# My B Code Project\n\nStart coding!\n`,
    );
  }
}

export async function listTree(dir = WORKSPACE_ROOT, depth = 0): Promise<TreeNode[]> {
  if (depth > 12) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nodes: TreeNode[] = [];
  for (const e of entries) {
    if (IGNORED.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      nodes.push({
        name: e.name,
        path: toRel(abs),
        type: "dir",
        children: await listTree(abs, depth + 1),
      });
    } else if (e.isFile()) {
      nodes.push({ name: e.name, path: toRel(abs), type: "file" });
    }
  }
  nodes.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
  );
  return nodes;
}

export async function readFile(rel: string): Promise<string> {
  const abs = resolveSafe(rel);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw new WorkspaceError("File not found", 404);
  if (!stat.isFile()) throw new WorkspaceError("Not a file");
  if (stat.size > MAX_FILE_BYTES) throw new WorkspaceError("File too large to open", 413);
  return fs.readFile(abs, "utf8");
}

export async function writeFile(rel: string, content: string): Promise<void> {
  const abs = resolveSafe(rel);
  if (abs === WORKSPACE_ROOT) throw new WorkspaceError("Invalid path");
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

export async function createEntry(rel: string, type: "file" | "dir"): Promise<void> {
  const abs = resolveSafe(rel);
  if (abs === WORKSPACE_ROOT) throw new WorkspaceError("Invalid path");
  const exists = await fs.stat(abs).then(() => true, () => false);
  if (exists) throw new WorkspaceError("Already exists", 409);
  if (type === "dir") {
    await fs.mkdir(abs, { recursive: true });
  } else {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "", "utf8");
  }
}

export async function removeEntry(rel: string): Promise<void> {
  const abs = resolveSafe(rel);
  if (abs === WORKSPACE_ROOT) throw new WorkspaceError("Cannot delete workspace root", 403);
  await fs.rm(abs, { recursive: true, force: true });
}

export async function renameEntry(from: string, to: string): Promise<void> {
  const a = resolveSafe(from);
  const b = resolveSafe(to);
  if (a === WORKSPACE_ROOT || b === WORKSPACE_ROOT) throw new WorkspaceError("Invalid path");
  const exists = await fs.stat(b).then(() => true, () => false);
  if (exists) throw new WorkspaceError("Destination already exists", 409);
  await fs.mkdir(path.dirname(b), { recursive: true });
  await fs.rename(a, b);
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export async function searchCode(query: string, limit = 200): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  const needle = query.toLowerCase();
  if (!needle) return hits;

  async function walk(dir: string): Promise<void> {
    if (hits.length >= limit) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (hits.length >= limit) return;
      if (IGNORED.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        const stat = await fs.stat(abs);
        if (stat.size > 1024 * 1024) continue;
        const buf = await fs.readFile(abs);
        if (buf.includes(0)) continue; // binary
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            hits.push({ path: toRel(abs), line: i + 1, text: lines[i].trim().slice(0, 200) });
          }
        }
      }
    }
  }

  await walk(WORKSPACE_ROOT);
  return hits;
}
