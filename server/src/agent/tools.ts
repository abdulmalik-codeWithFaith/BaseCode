import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { WORKSPACE_ROOT, WorkspaceError, removeEntry, resolveSafe, searchCode, toRel, writeFile } from "../workspace.js";
import { cleanEnv } from "../env.js";
import type { ToolSpec } from "./types.js";

const execFileP = promisify(execFile);

export class ToolError extends Error {}

export interface ToolOutcome {
  ok: boolean;
  /** Object returned to the model. */
  result: Record<string, unknown>;
  /** One short line shown to the user. */
  summary: string;
  /** True if the project files may have changed (UI refreshes the explorer and open tabs). */
  changed: boolean;
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "list_files",
    description: "List the files and folders directly inside one directory of the project (not recursive).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory relative to the project root. Default: the project root." } },
    },
  },
  {
    name: "read_file",
    description: "Read a text file. For large files pass start_line/end_line (1-based) to read a range.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        start_line: { type: "integer", description: "First line to return (1-based). Optional." },
        end_line: { type: "integer", description: "Last line to return (inclusive). Optional." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create a file, or completely replace an existing one, with the given content. Parent folders are created automatically.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        content: { type: "string", description: "The full new content of the file." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Change part of an existing file by replacing old_string with new_string. old_string must match the file exactly (including whitespace) and be unique unless replace_all is true. Read the file first.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        old_string: { type: "string", description: "Exact existing text to replace." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file or folder (folders are deleted recursively). The user must approve.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the project root." } },
      required: ["path"],
    },
  },
  {
    name: "search_code",
    description: "Case-insensitive text search across all project files. Returns matching lines with file and line number.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Text to look for." } },
      required: ["query"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the project root and return its output. No interactive input is available and the command is stopped after the time limit, so never start long-running servers or watchers. The user must approve.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command, e.g. npm install lucide-react" },
        timeout_seconds: { type: "integer", description: "Time limit in seconds (default 60, max 300)." },
      },
      required: ["command"],
    },
  },
  {
    name: "git_status",
    description: "Show the current branch and which files are modified, staged or untracked.",
  },
  {
    name: "git_diff",
    description: "Show uncommitted changes as a unified diff.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Limit the diff to this file. Optional." },
        staged: { type: "boolean", description: "Show staged changes instead of unstaged. Optional." },
      },
    },
  },
  {
    name: "git_commit",
    description: "Stage changes and create a commit. Stages only the given paths, or everything if none are given. The user must approve.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The commit message." },
        paths: { type: "array", items: { type: "string" }, description: "Files to stage. Optional (default: all changes)." },
      },
      required: ["message"],
    },
  },
];

// ---------------------------------------------------------------- approvals

const DANGEROUS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rRfF]|--recursive|--force)/,
  /\brm\b[^;&|\n]*\s(\/|~)/,
  /\bsudo\b/,
  /\bsu\s/,
  /\bgit\s+(push|reset\s+--hard|clean|checkout\s+--|branch\s+-D|filter-branch|rebase|remote\s+(add|set-url))/,
  /\b(curl|wget)\b[^|;\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
  /\bchmod\s+(-R|--recursive)/,
  /\bchown\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/(sd|nvme|disk)/,
  /:\(\)\s*\{/,
  /\b(shutdown|reboot)\b/,
  /\bkillall\b|\bkill\s+-9\b/,
  /\bnpm\s+(publish|login|adduser|token)\b/,
  /\.ssh\b|\/etc\/(passwd|shadow)|\.aws\/credentials|\.npmrc|\.netrc/,
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS.some((re) => re.test(command));
}

export type Approval = "auto" | "ask";

/** Decides whether a tool call needs the user's explicit OK. Dangerous commands always ask. */
export function approvalFor(name: string, args: Record<string, unknown>, autoApprove: boolean): { approval: Approval; dangerous: boolean } {
  if (name === "run_command") {
    const dangerous = isDangerousCommand(String(args.command ?? ""));
    return { approval: dangerous || !autoApprove ? "ask" : "auto", dangerous };
  }
  if (name === "delete_file" || name === "git_commit") {
    return { approval: autoApprove ? "auto" : "ask", dangerous: false };
  }
  return { approval: "auto", dangerous: false };
}

// ---------------------------------------------------------------- helpers

const MAX_READ_CHARS = 60_000;
const MAX_OUTPUT_CHARS = 16_000;

function str(args: Record<string, unknown>, key: string, opts: { optional?: boolean } = {}): string {
  const v = args[key];
  if (typeof v === "string") return v;
  if (opts.optional && (v === undefined || v === null)) return "";
  throw new ToolError(`Missing or invalid "${key}" (expected a string).`);
}

function int(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined;
}

/** Files the agent may never touch: git internals (hooks = code execution) and env files (secrets). */
function isProtected(rel: string): boolean {
  const segs = rel.toLowerCase().split("/").filter(Boolean);
  if (segs.includes(".git")) return true;
  const base = segs[segs.length - 1] ?? "";
  return /^\.env(\..+)?$/.test(base) && base !== ".env.example" && base !== ".env.sample";
}

async function assertInsideRealRoot(abs: string): Promise<void> {
  const root = await fs.realpath(WORKSPACE_ROOT);
  let p = abs;
  for (;;) {
    try {
      const real = await fs.realpath(p);
      if (real !== root && !real.startsWith(root + path.sep)) throw new ToolError("That path resolves outside the project (symlink).");
      return;
    } catch (err) {
      if (err instanceof ToolError) throw err;
      const parent = path.dirname(p);
      if (parent === p) return;
      p = parent;
    }
  }
}

/** Validates a project-relative path. Returns [relative, absolute]. */
async function projectPath(raw: string, opts: { allowRoot?: boolean; write?: boolean } = {}): Promise<[string, string]> {
  const input = raw.trim() || ".";
  const abs = resolveSafe(input === "." ? "" : input);
  if (abs === WORKSPACE_ROOT && !opts.allowRoot) throw new ToolError("Give a path to a file or folder inside the project.");
  const rel = abs === WORKSPACE_ROOT ? "" : toRel(abs);
  if (rel && isProtected(rel)) {
    throw new ToolError(`"${rel}" is protected: the agent cannot ${opts.write ? "change" : "read"} .env files or the .git folder.`);
  }
  await assertInsideRealRoot(abs);
  return [rel, abs];
}

function trimOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, 6000)}\n…[output truncated]…\n${text.slice(-10_000)}`;
}

function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    else process.kill(-child.pid, signal);
  } catch {
    /* already gone */
  }
}

function runShell(command: string, timeoutMs: number, signal: AbortSignal) {
  return new Promise<{ code: number | null; output: string; timedOut: boolean; aborted: boolean }>((resolve) => {
    const isWin = process.platform === "win32";
    const env = cleanEnv({ CI: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", PAGER: "cat" });
    const child = isWin
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], { cwd: WORKSPACE_ROOT, env, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(fsSync.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh", ["-c", command], {
          cwd: WORKSPACE_ROOT,
          env,
          detached: true, // own process group so a timeout can kill the whole tree
          stdio: ["ignore", "pipe", "pipe"],
        });

    let output = "";
    let timedOut = false;
    let aborted = false;
    const collect = (d: Buffer) => {
      if (output.length < 400_000) output += d.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const stop = () => {
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), 2000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ code, output: output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""), timedOut, aborted });
    };
    child.on("error", (err) => {
      output += `\n${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

async function runGit(args: string[], signal: AbortSignal): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileP("git", args, {
      cwd: WORKSPACE_ROOT,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 30_000,
      signal,
      env: cleanEnv({ GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", LC_ALL: "C" }),
    });
    return { code: 0, out: `${stdout}${stderr}`.trim() };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (e.code === "ENOENT") throw new ToolError("Git is not installed.");
    return { code: typeof e.code === "number" ? e.code : 1, out: `${e.stdout ?? ""}${e.stderr ?? e.message}`.trim() };
  }
}

// ---------------------------------------------------------------- tools

type Args = Record<string, unknown>;

const ok = (result: Record<string, unknown>, summary: string, changed = false): ToolOutcome => ({ ok: true, result: { ok: true, ...result }, summary, changed });

async function listFiles(args: Args): Promise<ToolOutcome> {
  const [rel, abs] = await projectPath(str(args, "path", { optional: true }), { allowRoot: true });
  const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => {
    throw new ToolError(`Folder not found: ${rel || "."}`);
  });
  const hidden = new Set([".git", "node_modules", "dist", ".next", ".cache"]);
  const names = entries
    .filter((e) => !hidden.has(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  return ok({ path: rel || ".", entries: names.slice(0, 500) }, `${names.length} items`);
}

async function readFileTool(args: Args): Promise<ToolOutcome> {
  const [rel, abs] = await projectPath(str(args, "path"));
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw new ToolError(`File not found: ${rel}`);
  if (!stat.isFile()) throw new ToolError(`${rel} is a folder. Use list_files.`);
  if (stat.size > 2 * 1024 * 1024) throw new ToolError(`${rel} is too large to read (${stat.size} bytes).`);
  const buf = await fs.readFile(abs);
  if (buf.includes(0)) throw new ToolError(`${rel} looks like a binary file.`);
  const lines = buf.toString("utf8").split("\n");
  const start = Math.max(1, int(args.start_line) ?? 1);
  const end = Math.min(lines.length, int(args.end_line) ?? lines.length);
  let content = lines.slice(start - 1, Math.max(start, end)).join("\n");
  const truncated = content.length > MAX_READ_CHARS;
  if (truncated) content = content.slice(0, MAX_READ_CHARS);
  return ok(
    { path: rel, total_lines: lines.length, start_line: start, end_line: end, truncated, content },
    truncated ? "read (truncated)" : `${Math.max(0, end - start + 1)} lines`,
  );
}

async function writeFileTool(args: Args): Promise<ToolOutcome> {
  const [rel, abs] = await projectPath(str(args, "path"), { write: true });
  const content = str(args, "content");
  if (content.length > 2_000_000) throw new ToolError("Content is too large.");
  const existed = await fs.stat(abs).then((s) => s.isFile(), () => false);
  if (!existed && (await fs.stat(abs).then(() => true, () => false))) throw new ToolError(`${rel} is a folder.`);
  await writeFile(rel, content);
  return ok({ path: rel, created: !existed, bytes: Buffer.byteLength(content) }, existed ? "Overwrote file" : "Created file", true);
}

async function editFileTool(args: Args): Promise<ToolOutcome> {
  const [rel, abs] = await projectPath(str(args, "path"), { write: true });
  const oldStr = str(args, "old_string");
  const newStr = str(args, "new_string");
  if (!oldStr) throw new ToolError("old_string must not be empty. Use write_file to create or replace a whole file.");
  if (oldStr === newStr) throw new ToolError("old_string and new_string are identical.");
  const text = await fs.readFile(abs, "utf8").catch(() => {
    throw new ToolError(`File not found: ${rel}`);
  });
  const count = text.split(oldStr).length - 1;
  if (count === 0) throw new ToolError("old_string was not found. It must match the file exactly, including whitespace. Read the file again.");
  const all = args.replace_all === true;
  if (count > 1 && !all) throw new ToolError(`old_string matches ${count} places. Add more surrounding context to make it unique, or set replace_all.`);
  await writeFile(rel, text.split(oldStr).join(newStr));
  return ok({ path: rel, replacements: all ? count : 1 }, `Edited (${all ? count : 1} change${all && count > 1 ? "s" : ""})`, true);
}

async function deleteFileTool(args: Args): Promise<ToolOutcome> {
  const [rel] = await projectPath(str(args, "path"), { write: true });
  const exists = await fs.stat(resolveSafe(rel)).then(() => true, () => false);
  if (!exists) throw new ToolError(`Not found: ${rel}`);
  await removeEntry(rel);
  return ok({ path: rel }, "Deleted", true);
}

async function searchCodeTool(args: Args): Promise<ToolOutcome> {
  const query = str(args, "query");
  if (!query.trim()) throw new ToolError("query must not be empty.");
  const hits = (await searchCode(query, 60)).filter((h) => !isProtected(h.path));
  return ok({ query, matches: hits, note: hits.length >= 60 ? "Showing the first 60 matches." : undefined }, `${hits.length} match${hits.length === 1 ? "" : "es"}`);
}

async function runCommandTool(args: Args, signal: AbortSignal): Promise<ToolOutcome> {
  const command = str(args, "command").trim();
  if (!command) throw new ToolError("command must not be empty.");
  const seconds = Math.min(300, Math.max(1, int(args.timeout_seconds) ?? 60));
  const r = await runShell(command, seconds * 1000, signal);
  const output = trimOutput(r.output.trim());
  if (r.aborted) return { ok: false, result: { error: "Stopped by the user.", output }, summary: "Stopped", changed: true };
  if (r.timedOut) {
    return {
      ok: false,
      result: { error: `Timed out after ${seconds}s and was stopped. Do not run long-running servers; ask the user to start them in their terminal.`, output },
      summary: `Timed out (${seconds}s)`,
      changed: true,
    };
  }
  return {
    ok: r.code === 0,
    result: { exit_code: r.code, output: output || "(no output)" },
    summary: r.code === 0 ? "exit 0" : `exit ${r.code ?? "?"}`,
    changed: true,
  };
}

async function gitStatusTool(_args: Args, signal: AbortSignal): Promise<ToolOutcome> {
  const r = await runGit(["status", "--short", "--branch"], signal);
  return { ok: r.code === 0, result: { output: trimOutput(r.out) || "(clean)" }, summary: r.code === 0 ? "status" : "not a repository", changed: false };
}

async function gitDiffTool(args: Args, signal: AbortSignal): Promise<ToolOutcome> {
  const argv = ["diff", "--no-color"];
  if (args.staged === true) argv.push("--staged");
  const p = str(args, "path", { optional: true });
  if (p) {
    const [rel] = await projectPath(p);
    argv.push("--", rel);
  }
  const r = await runGit(argv, signal);
  return { ok: r.code === 0, result: { diff: trimOutput(r.out) || "(no changes)" }, summary: r.out ? "diff" : "no changes", changed: false };
}

async function gitCommitTool(args: Args, signal: AbortSignal): Promise<ToolOutcome> {
  const message = str(args, "message").trim();
  if (!message) throw new ToolError("Commit message must not be empty.");
  const paths = Array.isArray(args.paths) ? args.paths.filter((x): x is string => typeof x === "string") : [];
  const rels: string[] = [];
  for (const p of paths) rels.push((await projectPath(p))[0]);
  const add = await runGit(rels.length ? ["add", "-A", "--", ...rels] : ["add", "-A"], signal);
  if (add.code !== 0) return { ok: false, result: { error: add.out }, summary: "stage failed", changed: false };
  const commit = await runGit(["commit", "-m", message], signal);
  return { ok: commit.code === 0, result: commit.code === 0 ? { ok: true, output: trimOutput(commit.out) } : { error: trimOutput(commit.out) }, summary: commit.code === 0 ? "Committed" : "commit failed", changed: true };
}

export async function executeTool(name: string, args: Args, signal: AbortSignal): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "list_files":
        return await listFiles(args);
      case "read_file":
        return await readFileTool(args);
      case "write_file":
        return await writeFileTool(args);
      case "edit_file":
        return await editFileTool(args);
      case "delete_file":
        return await deleteFileTool(args);
      case "search_code":
        return await searchCodeTool(args);
      case "run_command":
        return await runCommandTool(args, signal);
      case "git_status":
        return await gitStatusTool(args, signal);
      case "git_diff":
        return await gitDiffTool(args, signal);
      case "git_commit":
        return await gitCommitTool(args, signal);
      default:
        throw new ToolError(`Unknown tool "${name}".`);
    }
  } catch (err) {
    const message = err instanceof ToolError || err instanceof WorkspaceError ? err.message : `Tool failed: ${(err as Error).message}`;
    return { ok: false, result: { error: message }, summary: message.length > 90 ? `${message.slice(0, 87)}…` : message, changed: false };
  }
}