import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Express, Request, Response } from "express";
import express from "express";
import httpProxy from "http-proxy";
import { WORKSPACE_ROOT } from "./workspace.js";

const proxy = httpProxy.createProxyServer({ changeOrigin: true, ws: true });
proxy.on("error", (_err, _req, res) => {
  const r = res as Response | undefined;
  if (r && "writeHead" in r && !r.headersSent) {
    r.writeHead(502, { "Content-Type": "text/html" });
    r.end(
      `<body style="font-family:system-ui;padding:2rem;color:#999;background:#111">` +
        `<h3>Nothing is running on that port yet</h3>` +
        `<p>Start your dev server in the terminal (e.g. <code>npm run dev</code>), then refresh.</p></body>`,
    );
  }
});

const PORT_RE = /^\/proxy\/(\d{2,5})(\/.*)?$/;

function validPort(p: number): boolean {
  return p >= 1024 && p <= 65535;
}

export function mountPreview(app: Express, serverPort: number): void {
  // Static preview: serve workspace files as a website (plain HTML/CSS/JS projects).
  app.use(
    "/static",
    express.static(WORKSPACE_ROOT, {
      index: "index.html",
      dotfiles: "deny",
      etag: false,
      setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
    }),
  );

  // Dev-server preview: reverse-proxy http://localhost:<port> through /proxy/<port>/...
  app.use((req: Request, res: Response, next) => {
    const m = PORT_RE.exec(req.url.split("?")[0]);
    if (!m) return next();
    const port = Number(m[1]);
    if (!validPort(port) || port === serverPort) {
      res.status(400).send("Invalid preview port");
      return;
    }
    req.url = (m[2] ?? "/") + (req.url.includes("?") ? "?" + req.url.split("?")[1] : "");
    proxy.web(req, res, { target: `http://127.0.0.1:${port}` });
  });
}

export function handlePreviewUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  serverPort: number,
): boolean {
  const m = PORT_RE.exec((req.url ?? "").split("?")[0]);
  if (!m) return false;
  const port = Number(m[1]);
  if (!validPort(port) || port === serverPort) {
    socket.destroy();
    return true;
  }
  req.url = (m[2] ?? "/") + ((req.url ?? "").includes("?") ? "?" + (req.url ?? "").split("?")[1] : "");
  proxy.ws(req, socket, head, { target: `ws://127.0.0.1:${port}` });
  return true;
}

export type { Server };
