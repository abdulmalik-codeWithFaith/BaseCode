import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { cleanEnv } from "./env.js";
import { WORKSPACE_ROOT, WorkspaceError, resolveSafe, toRel } from "./workspace.js";

const execFileP = promisify(execFile);

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run git without a shell (args are never interpreted), never prompting for input. */
async function git(args: string[], opts: { allowFail?: boolean } = {}): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileP("git", args, {
      cwd: WORKSPACE_ROOT,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 60_000,
      env: cleanEnv({ GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", LC_ALL: "C" }),
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (e.code === "ENOENT") throw new WorkspaceError("Git is not installed on the server", 500);
    if (opts.allowFail) {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? String(e.message), code: typeof e.code === "number" ? e.code : 1 };
    }
    throw new WorkspaceError(friendlyError(e.stderr || e.stdout || e.message || "git failed"), 400);
  }
}

function friendlyError(raw: string): string {
  const text = raw.trim();
  if (/tell me who you are|empty ident name|unable to auto-detect email/i.test(text)) {
    return 'Git needs your identity first. In the terminal run: git config --global user.name "Your Name" and git config --global user.email "you@example.com"';
  }
  if (/could not read Username|terminal prompts disabled|Authentication failed|Permission denied \(publickey\)/i.test(text)) {
    return "Git needs you to sign in. Run the push/pull once in the terminal (or set up an SSH key / credential helper), then try again.";
  }
  if (/Not possible to fast-forward|divergent branches/i.test(text)) {
    return "Branches have diverged, so a simple pull is not possible. Resolve it in the terminal (git pull --rebase, or merge).";
  }
  if (/does not appear to be a git repository|No such remote|Could not read from remote/i.test(text) && /origin/.test(text)) {
    return "No remote is set up yet. In the terminal run: git remote add origin <your-repo-url> and then push again.";
  }
  if (/nothing (added )?to commit|no changes added to commit/i.test(text)) {
    return "Nothing is staged. Stage some changes first, then commit.";
  }
  return text.split("\n").slice(0, 6).join("\n");
}

/** True only when the workspace folder itself is the repo root (not a parent repo). */
async function isRepo(): Promise<boolean> {
  const r = await git(["rev-parse", "--show-toplevel"], { allowFail: true });
  if (r.code !== 0) return false;
  try {
    const [top, root] = await Promise.all([fs.realpath(r.stdout.trim()), fs.realpath(WORKSPACE_ROOT)]);
    return top === root;
  } catch {
    return false;
  }
}

async function hasCommits(): Promise<boolean> {
  return (await git(["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true })).code === 0;
}

/** Validate user supplied paths and return them workspace-relative. */
function safePaths(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) throw new WorkspaceError("paths required");
  return input.map((p) => {
    if (typeof p !== "string" || !p) throw new WorkspaceError("Invalid path");
    const abs = resolveSafe(p);
    if (abs === WORKSPACE_ROOT) throw new WorkspaceError("Invalid path");
    return toRel(abs);
  });
}

function validBranch(name: unknown): string {
  if (typeof name !== "string" || !name.trim() || name.startsWith("-") || name.length > 200) {
    throw new WorkspaceError("Invalid branch name");
  }
  return name.trim();
}

export interface GitFile {
  path: string;
  index: string; // staged status letter, " " if none, "?" if untracked
  worktree: string; // unstaged status letter, " " if none, "?" if untracked
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

const MAX_FILES = 500;

async function status(): Promise<GitStatus> {
  const empty: GitStatus = {
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    branches: [],
    truncated: false,
  };
  if (!(await isRepo())) return empty;

  const { stdout } = await git(["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all"]);
  const parts = stdout.split("\0");
  let header = (parts.shift() ?? "").replace(/^## /, "");

  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  const noCommits = /^No commits yet on (.+)$/.exec(header);
  if (noCommits) {
    branch = noCommits[1];
  } else if (header.startsWith("HEAD (no branch)")) {
    branch = "HEAD (detached)";
  } else {
    const tracking = / \[(.+)\]$/.exec(header);
    if (tracking) {
      ahead = Number(/ahead (\d+)/.exec(tracking[1])?.[1] ?? 0);
      behind = Number(/behind (\d+)/.exec(tracking[1])?.[1] ?? 0);
      header = header.slice(0, tracking.index);
    }
    const [b, u] = header.split("...");
    branch = b || null;
    upstream = u ?? null;
  }

  const files: GitFile[] = [];
  let truncated = false;
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const x = rec[0];
    const y = rec[1];
    if (x === "R" || x === "C") i++; // next record is the original path
    if (files.length >= MAX_FILES) {
      truncated = true;
      continue;
    }
    files.push({ path: rec.slice(3), index: x, worktree: y });
  }

  const br = await git(["branch", "--format=%(refname:short)"], { allowFail: true });
  const branches = br.stdout.split("\n").map((s) => s.trim()).filter(Boolean);

  return { isRepo: true, branch, upstream, ahead, behind, files, branches, truncated };
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export const gitRouter = express.Router();

gitRouter.get(
  "/status",
  wrap(async (_req, res) => {
    res.json(await status());
  }),
);

gitRouter.post(
  "/init",
  wrap(async (_req, res) => {
    if (await isRepo()) throw new WorkspaceError("Already a Git repository", 409);
    const first = await git(["init", "-b", "main"], { allowFail: true });
    if (first.code !== 0) await git(["init"]);
    const ignore = path.join(WORKSPACE_ROOT, ".gitignore");
    const hasIgnore = await fs.stat(ignore).then(() => true, () => false);
    if (!hasIgnore) await fs.writeFile(ignore, "node_modules\ndist\n.env\n.DS_Store\n", "utf8");
    res.json({ ok: true });
  }),
);

gitRouter.post(
  "/stage",
  wrap(async (req, res) => {
    await git(["add", "-A", "--", ...safePaths(req.body?.paths)]);
    res.json({ ok: true });
  }),
);

gitRouter.post(
  "/unstage",
  wrap(async (req, res) => {
    const paths = safePaths(req.body?.paths);
    if (await hasCommits()) await git(["reset", "-q", "HEAD", "--", ...paths]);
    else await git(["rm", "--cached", "-r", "-q", "--", ...paths]);
    res.json({ ok: true });
  }),
);

gitRouter.post(
  "/discard",
  wrap(async (req, res) => {
    for (const rel of safePaths(req.body?.paths)) {
      const untracked = (await git(["ls-files", "--others", "--exclude-standard", "--", rel])).stdout.trim() !== "";
      if (untracked) await fs.rm(resolveSafe(rel), { recursive: true, force: true });
      else await git(["restore", "--worktree", "--", rel]);
    }
    res.json({ ok: true });
  }),
);

gitRouter.post(
  "/commit",
  wrap(async (req, res) => {
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) throw new WorkspaceError("Commit message required");
    await git(["commit", "-m", message]);
    res.json({ ok: true });
  }),
);

gitRouter.post(
  "/checkout",
  wrap(async (req, res) => {
    const name = validBranch(req.body?.branch);
    if (req.body?.create) {
      const ok = await git(["check-ref-format", "--branch", name], { allowFail: true });
      if (ok.code !== 0) throw new WorkspaceError("That is not a valid branch name");
      await git(["switch", "-c", name]);
    } else {
      await git(["switch", name]);
    }
    res.json({ ok: true });
  }),
);

gitRouter.post(
  "/push",
  wrap(async (_req, res) => {
    const st = await status();
    if (!st.branch) throw new WorkspaceError("No branch to push");
    if (st.upstream) await git(["push"]);
    else await git(["push", "--set-upstream", "origin", "HEAD"]);
    res.json({ ok: true });
  }),
);

gitRouter.post(
  "/pull",
  wrap(async (_req, res) => {
    const r = await git(["pull", "--ff-only"]);
    res.json({ ok: true, message: (r.stdout || r.stderr).trim() });
  }),
);

gitRouter.get(
  "/log",
  wrap(async (_req, res) => {
    const r = await git(["log", "-n", "20", "--pretty=format:%h%x1f%an%x1f%ar%x1f%s"], { allowFail: true });
    const commits = r.code === 0 && r.stdout
      ? r.stdout.split("\n").map((line) => {
          const [hash, author, when, subject] = line.split("\x1f");
          return { hash, author, when, subject };
        })
      : [];
    res.json({ commits });
  }),
);

/** Contents of a file at HEAD (for the diff viewer). exists=false for new files. */
gitRouter.get(
  "/show",
  wrap(async (req, res) => {
    const [rel] = safePaths([typeof req.query.path === "string" ? req.query.path : ""]);
    const r = await git(["show", `HEAD:${rel}`], { allowFail: true });
    res.json(r.code === 0 ? { exists: true, content: r.stdout } : { exists: false, content: "" });
  }),
);