import "./env.js"; // must stay first: loads server/.env before anything reads process.env
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { WebSocketServer } from "ws";
import {
  WORKSPACE_ROOT,
  WorkspaceError,
  createEntry,
  ensureWorkspace,
  listTree,
  readFile,
  removeEntry,
  renameEntry,
  searchCode,
  writeFile,
} from "./workspace.js";
import { attachTerminal } from "./terminal.js";
import { attachAgent } from "./agent/socket.js";
import { agentStatus } from "./agent/provider.js";
import { hostAllowed, originAllowed, securityMiddleware } from "./security.js";

import { handlePreviewUpgrade, mountPreview } from "./preview.js";
import { gitRouter } from "./git.js";
const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "127.0.0.1";

await ensureWorkspace();

const app = express();
app.use(securityMiddleware);
app.use(express.json({ limit: "10mb" }));

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, workspace: path.basename(WORKSPACE_ROOT) });
});

app.get("/api/agent/status", (_req, res) => {
  res.json(agentStatus());
});

app.get(
  "/api/tree",
  wrap(async (_req, res) => {
    res.json({ name: path.basename(WORKSPACE_ROOT), children: await listTree() });
  }),
);

app.get(
  "/api/file",
  wrap(async (req, res) => {
    res.json({ path: str(req.query.path), content: await readFile(str(req.query.path)) });
  }),
);

app.put(
  "/api/file",
  wrap(async (req, res) => {
    if (typeof req.body?.content !== "string") throw new WorkspaceError("content required");
    await writeFile(str(req.body.path), req.body.content);
    res.json({ ok: true });
  }),
);

app.post(
  "/api/entry",
  wrap(async (req, res) => {
    const type = req.body?.type === "dir" ? "dir" : "file";
    await createEntry(str(req.body?.path), type);
    res.json({ ok: true });
  }),
);

app.delete(
  "/api/entry",
  wrap(async (req, res) => {
    await removeEntry(str(req.query.path));
    res.json({ ok: true });
  }),
);

app.post(
  "/api/rename",
  wrap(async (req, res) => {
    await renameEntry(str(req.body?.from), str(req.body?.to));
    res.json({ ok: true });
  }),
);

app.get(
  "/api/search",
  wrap(async (req, res) => {
    res.json({ hits: await searchCode(str(req.query.q)) });
  }),
);
app.use("/api/git", gitRouter);
mountPreview(app, PORT);

// Serve the built web app in production.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|static|proxy|ws).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof WorkspaceError) {
    res.status(err.status).json({ error: err.message });
  } else if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
    res.status(404).json({ error: "Not found" });
  } else {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = (req.url ?? "").split("?")[0];
  const reject = (status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (!hostAllowed(req)) return reject("403 Forbidden");

  if (url === "/ws/terminal" || url === "/ws/agent") {
    // Browsers do not apply the same-origin policy to WebSockets, so we must: otherwise any website
    // could open a shell on this machine. (Preview/HMR sockets under /proxy are exempt below.)
    if (!originAllowed(req)) return reject("403 Forbidden");
    wss.handleUpgrade(req, socket, head, (ws) => (url === "/ws/terminal" ? attachTerminal(ws) : attachAgent(ws)));
  } else if (!handlePreviewUpgrade(req, socket, head, PORT)) {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`B Code server listening on http://${HOST}:${PORT}`);
  console.log(`Workspace: ${WORKSPACE_ROOT}`);
});
