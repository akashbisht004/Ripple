/**
 * Dev/start bootstrap for the RIPPLE web app.
 *
 * Next only loads env files from the app directory, but RIPPLE keeps the
 * canonical config at the repo root (`../.env`). Node child processes spawned
 * by the dev server only inherit *OS-process* env, so we hydrate process.env
 * before launching Next (in-JS propagation doesn't reach its workers).
 */
import { join } from "node:path";
import { spawn } from "node:child_process";
import { loadDotEnv } from "./src/load-env.mjs";

for (const dir of [process.cwd(), join(process.cwd(), "..", "..")]) {
  loadDotEnv(dir);
}

const [, , ...nextArgs] = process.argv;
const child = spawn("next", nextArgs, { stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code ?? 0));
