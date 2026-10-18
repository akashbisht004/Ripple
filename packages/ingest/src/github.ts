/**
 * GitHub hydration — Phase 2.
 *
 * Turns heuristic `Bug` nodes (from commit-msg heuristics) into *linked*
 * evidence nodes by pulling real payloads from the GitHub API:
 *
 *   Bug ← issueRef(#12)          → GET /repos/{o}/{r}/issues/12
 *                                  (title, state, html_url)
 *   Commit sha                   → GET /repos/{o}/{r}/commits/{sha}
 *                                  (html_url, verified author)
 *
 * Works unauthenticated for public repos; `GITHUB_TOKEN` (app classic PAT or
 * fine-grained) raises rate limits and unlocks private repos. All failures
 * degrade gracefully — the heuristic title stays in the graph.
 */
import type { Graph } from "falkordb";

export interface GithubRepoRef {
  owner: string;
  repo: string;
}

/** Parse `owner/repo` out of a git remote URL (ssh or https). */
export function parseRemoteUrl(url: string): GithubRepoRef | null {
  const ssh = /(?:com|net)[:/]{1,2}([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(url.trim());
  const https = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(url.trim());
  const m = https ?? ssh;
  if (!m) return null;
  return { owner: m[1] ?? "", repo: m[2] ?? "" };
}

function ghHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "ripple-graph",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function ghJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: ghHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

export async function detectGithubRepo(root: string): Promise<GithubRepoRef | null> {
  const { execFile } = await import("node:child_process");
  const url = await new Promise<string | null>((resolve) => {
    execFile("git", ["config", "--get", "remote.origin.url"], { cwd: root }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
  return url ? parseRemoteUrl(url) : null;
}

export interface BugEvidenceInput {
  /** Graph key of the Bug node (e.g. `bug#17c5cb0c…`). */
  bugKey: string;
  heuristicTitle: string;
  issueRefs: string[];
  sha: string;
}

export interface HydratedBug {
  bugKey: string;
  title: string;
  url: string | null;
  state: string | null;
  source: "issue" | "commit" | "heuristic";
}

interface IssuePayload {
  title?: string;
  state?: string;
  html_url?: string;
}

interface CommitPayload {
  html_url?: string;
}

/** Fetch evidence rows for each bug; per-item failure keeps heuristics. */
export async function fetchBugEvidence(
  repo: GithubRepoRef,
  bugs: BugEvidenceInput[],
): Promise<HydratedBug[]> {
  const base = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
  const runGraph = `https://github.com/${repo.owner}/${repo.repo}/commit/`;
  const out: HydratedBug[] = [];

  for (const b of bugs) {
    let hydrated: HydratedBug = {
      bugKey: b.bugKey,
      title: b.heuristicTitle,
      url: b.sha ? `${runGraph}${b.sha}` : null,
      state: null,
      source: "heuristic",
    };

    const refNum = b.issueRefs[0];
    if (refNum) {
      const issue = (await ghJson(`${base}/issues/${refNum}`)) as IssuePayload | null;
      if (issue?.title) {
        hydrated = {
          bugKey: b.bugKey,
          title: issue.title,
          url: issue.html_url ?? hydrated.url,
          state: issue.state ?? null,
          source: "issue",
        };
      }
    } else if (b.sha) {
      const commit = (await ghJson(`${base}/commits/${b.sha}`)) as CommitPayload | null;
      if (commit?.html_url) {
        hydrated = { ...hydrated, url: commit.html_url, source: "commit" };
      }
    }
    out.push(hydrated);
  }
  return out;
}

interface BugPersistRow {
  key: string;
  title: string;
  url: string | null;
  state: string | null;
  hydrated: boolean;
}

/** Persist hydration onto `(:Bug {key})` nodes via batched MERGE update. */
export async function writeHydration(graph: Graph, bugs: HydratedBug[]): Promise<number> {
  if (bugs.length === 0) return 0;
  const rows: BugPersistRow[] = bugs.map((b) => ({
    key: b.bugKey,
    title: b.title,
    url: b.url,
    state: b.state,
    hydrated: b.source !== "heuristic",
  }));
  const res = await graph.query(
    `UNWIND $rows AS row
     MATCH (b:Bug { key: row.key })
     SET b.title = row.title,
         b.url = row.url,
         b.state = row.state,
         b.hydrated = row.hydrated`,
    { params: { rows } } as never,
  );
  void res;
  return rows.filter((r) => r.hydrated).length;
}
