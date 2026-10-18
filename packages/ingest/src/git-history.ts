/**
 * Git history miner — Phase 2.
 *
 * Single `git log -U0 --name-status` pass turns history into evidence:
 *
 *   (:Commit {sha, message, date, isBugFix})
 *   (:Commit)-[:TOUCHED]->(:File)
 *   (:Commit)-[:FIXED]->(:Bug {key, title, refs})     (heuristic + issue refs)
 *
 * Per-commit diff hunks (@@ -a,b +c,d @@, new-line space) and file statuses
 * (A/M/D/R with old→new paths)enable function-level attribution and rename/
 * delete handling in the orchestrator. GitHub hydration (real issue/commit
 * payloads) lives in `github.ts`.
 */
import { execFile } from "node:child_process";

export interface Hunk {
  /** 1-based first changed line in the *new* file. */
  start: number;
  count: number;
}

export interface MinedCommit {
  sha: string;
  message: string;
  date: string;
  files: string[];
  statuses: Array<{ path: string; oldPath: string | null; status: string }>;
  /** Changed line ranges per file, keyed by new (current) path. */
  hunksByFile: Record<string, Hunk[]>;
  isBugFix: boolean;
  issueRefs: string[];
}

const BUG_FIX_RE = /\b(fix(es|ed)?|fixup|bug|regression|hotfix|closes?|resolves?)\b/i;
const ISSUE_REF_RE = /#(\d+)\b/g;
const NUM_RE = /^(\d+)(?:,(\d+))?$/;

function runGit(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || err.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export function isRepo(root: string): Promise<boolean> {
  return runGit(root, ["rev-parse", "--is-inside-work-tree"])
    .then(() => true)
    .catch(() => false);
}

function num(v: string | undefined): number {
  if (!v) return 0;
  const m = NUM_RE.exec(v);
  return m ? (m[1] ? parseInt(m[1], 10) : 0) : parseInt(v, 10);
}

interface Draft {
  sha: string;
  date: string;
  subject: string;
  statuses: MinedCommit["statuses"];
  hunks: MinedCommit["hunksByFile"];
  currentOldPath: string | null;
  currentNewPath: string | null;
}

export async function mineGitHistory(root: string, maxCommits: number = 500): Promise<MinedCommit[]> {
  // -p (patch) is required: --name-status would suppress the diff hunks
  const raw = await runGit(root, [
    "log",
    `--max-count=${maxCommits}`,
    "-p",
    "--unified=0",
    "--no-color",
    "--pretty=format:@@COMMIT@@%H|%aI|%s",
  ]);

  const drafts: Draft[] = [];
  let d: Draft | null = null;

  for (const line of raw.split("\n")) {
    if (line.startsWith("@@COMMIT@@")) {
      const [sha, date, ...msg] = line.slice("@@COMMIT@@".length).split("|");
      d = {
        sha: sha?.trim() ?? "",
        date: date?.trim() ?? new Date().toISOString(),
        subject: msg.join("|").trim(),
        statuses: [],
        hunks: {},
        currentOldPath: null,
        currentNewPath: null,
      };
      drafts.push(d);
    } else if (!d || !line.trim()) {
      continue;
    } else if (line.startsWith("diff --git")) {
      // a/<old> b/<new> — rename-safe; refined by ---/+++ lines below
      const m = /a\/(\S+) b\/(\S+)/.exec(line);
      d.currentOldPath = m ? (m[1] ?? null) : null;
      d.currentNewPath = m ? (m[2] ?? null) : null;
    } else if (line.startsWith("rename from ")) {
      d.currentOldPath = line.slice("rename from ".length).trim();
    } else if (line.startsWith("rename to ")) {
      const to = line.slice("rename to ".length).trim();
      d.currentNewPath = to;
      if (d.currentOldPath) {
        d.statuses.push({ path: to, oldPath: d.currentOldPath, status: "R" });
      }
    } else if (line.startsWith("deleted file mode")) {
      d.statuses.push({ path: d.currentOldPath ?? d.currentNewPath ?? "", oldPath: null, status: "D" });
    } else if (line.startsWith("new file mode")) {
      d.statuses.push({ path: d.currentNewPath ?? "", oldPath: null, status: "A" });
    } else if (line.startsWith("--- ")) {
      const p = line.replace(/^--- (?:a\/)?/, "").trim();
      const isSymbolic = p === "/dev/null" || p.startsWith("/");
      d.currentOldPath = isSymbolic ? null : p;
    } else if (line.startsWith("+++ ")) {
      const p = line.replace(/^\+\+\+ (?:b\/)?/, "").trim();
      d.currentNewPath = p === "/dev/null" ? null : p;
      if (d.currentNewPath && !d.statuses.some((s) => s.path === (d?.currentNewPath ?? ""))) {
        d.statuses.push({ path: d.currentNewPath, oldPath: d.currentOldPath, status: "M" });
      }
    } else if (line.startsWith("@@ ") && d.currentNewPath) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        const start = parseInt(m[2] ?? "0", 10);
        const count = m[3] ? parseInt(m[3], 10) : 1;
        if (start > 0 && (count > 0 || true)) {
          const bucket = d.hunks[d.currentNewPath] ?? [];
          bucket.push({ start, count });
          d.hunks[d.currentNewPath] = bucket;
        }
      }
    }
    // patch body lines (+/-/context) are ignored; hunks carry the ranges
  }

  return drafts
    .filter((c) => c.sha && c.statuses.length > 0)
    .map((c) => {
      const issueRefs = [...c.subject.matchAll(ISSUE_REF_RE)].map((m) => m[1] ?? "").filter(Boolean);
      const files = [...new Set(c.statuses.flatMap((s) => [s.path, s.oldPath ?? s.path]))]
        .filter((f) => f && !f.includes("node_modules") && f.includes("/"));
      return {
        sha: c.sha,
        message: c.subject,
        date: c.date,
        files,
        statuses: c.statuses,
        hunksByFile: c.hunks,
        isBugFix: BUG_FIX_RE.test(c.subject),
        issueRefs,
      };
    });
}
