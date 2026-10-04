import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads server/.env (or a repo-root .env) into process.env. Variables that are already set in the
 * real environment win. Import this module first in index.ts.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
for (const file of [path.resolve(here, "../.env"), path.resolve(here, "../../.env")]) {
  if (fs.existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch (err) {
      console.warn(`Could not read ${file}:`, (err as Error).message);
    }
  }
}

/** Secrets that must never reach shells, terminals or commands started by the agent. */
const SECRET_VARS = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];

/** A copy of process.env without B Code's own secrets, plus any extra variables. */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of SECRET_VARS) delete env[name];
  return { ...env, ...extra };
}