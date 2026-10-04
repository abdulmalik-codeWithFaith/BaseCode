import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";

/**
 * Protection for a server that can run shell commands on this machine.
 *
 *  - Host check: blocks DNS-rebinding (a web page pointing its own domain at 127.0.0.1).
 *  - Origin check: blocks cross-site WebSocket hijacking. Browsers do NOT apply the same-origin
 *    policy to WebSockets, so without this any website you visit could open a terminal here.
 *
 * To serve B Code on another hostname, set BCODE_ALLOWED_HOSTS=name1,name2 in server/.env.
 */
function allowedHosts(): Set<string> {
  const extra = (process.env.BCODE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(["localhost", "127.0.0.1", "[::1]", ...extra]);
}

function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  const h = hostHeader.toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? "" : h.slice(0, end + 1);
  }
  return h.split(":")[0];
}

export function hostAllowed(req: IncomingMessage): boolean {
  return allowedHosts().has(hostnameOf(req.headers.host));
}

/** No Origin = not a browser (curl, scripts), which a web page cannot drive. Otherwise it must match Host. */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === (req.headers.host ?? "").toLowerCase();
  } catch {
    return false; // includes the opaque "null" origin of sandboxed frames
  }
}

export function securityMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!hostAllowed(req)) {
    res.status(403).send("Forbidden: unrecognized Host header. Set BCODE_ALLOWED_HOSTS to allow it.");
    return;
  }
  const safeMethod = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
  // Only our own API is origin-checked: previewed apps (served via /static and /proxy) legitimately
  // run with an opaque origin inside the sandboxed preview frame.
  if (!safeMethod && req.path.startsWith("/api") && !originAllowed(req)) {
    res.status(403).json({ error: "Cross-origin request blocked" });
    return;
  }
  next();
}