#!/usr/bin/env node
/**
 * Restores the bundled demo repo (samples/demo-ts-repo) on a fresh clone.
 *
 * The demo repo ships as `samples/demo-ts-repo.bundle` because the outer
 * repository can't track a nested `.git`. The bundle carries the full seeded
 * history — the bug-fix commits ("fix: correct computeDiscount rounding
 * precision, fixes #12", etc.) that RIPPLE's git miner turns into the
 * :Bug / :Commit evidence graph. Run `npm run demo:seed` once after cloning.
 */
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, "samples", "demo-ts-repo");
const bundle = path.join(root, "samples", "demo-ts-repo.bundle");

if (existsSync(path.join(dir, ".git"))) {
  console.log("✓ demo repo already seeded:", dir);
  process.exit(0);
}
if (!existsSync(bundle)) {
  console.error(`✖ bundle not found: ${bundle}`);
  process.exit(1);
}

console.log("seeding demo repo with git history…");
rmSync(dir, { recursive: true, force: true });
execSync(`git clone "${bundle}" "${dir}"`, { stdio: "inherit" });
console.log(`✓ done — full history restored, log:
${execSync("git -C samples/demo-ts-repo log --oneline").toString()}`);
