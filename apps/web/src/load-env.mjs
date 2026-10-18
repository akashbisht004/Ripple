/**
 * Minimal .env loader shared by server.mjs (bootstrap) and next.config.mjs.
 *
 * Next auto-loads env files only from the app directory, but RIPPLE keeps the
 * canonical config at the repo root. Existing values in process.env always win
 * (shell-provided env > app-local file > repo-root file).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function loadDotEnv(dir) {
  for (const name of [".env.local", ".env"]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m?.[1]) continue;
      const key = m[1];const raw = (m[2] ?? "").trim();
      // strip a surrounding single/double quote pair, keep inner content
      const val = /^["'].*["']$/.test(raw) ? raw.slice(1, -1) : raw;
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}
