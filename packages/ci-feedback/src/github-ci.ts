/**
 * GitHub CI result extraction (Phase 5, GitHub mode).
 *
 * For a PR: resolve the head commit → list check runs → for every FAILED run,
 * pull its annotations and harvest the test FILE paths that GitHub Actions /
 * pytest / jest style test steps annotate. Confirmed predictions come from
 * real failures; provenance stays one click away (run URLs).
 *
 * Octokit-free — plain fetch, same as packages/agent's pr-fetcher.
 */
import { normalizeTestPath } from "./feedback.js";

const GH_API = "https://api.github.com";
const TEST_FILE_RE = /\.(test|spec)\.[jt]sx?$|__tests__\/|(^|\/)tests?\//i;

export interface GhRef {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface CiExtraction {
  label: string;
  headSha: string;
  failed: string[];
  /** run URLs of failing checks that produced the failed files */
  fromRuns: string[];
  /** failed checks that looked like test suites but yielded no file paths */
  unparseableRuns: string[];
}

/** Local PR-URL parser (duplicate of agent's helper — ci-feedback must not depend on @ripple/agent). */
export function prUrlToRef(url: string): GhRef | null {
  const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/pull(?:.s)?\/(\d+)/.exec(url.trim());
  if (!m) return null;
  return { owner: m[1] ?? "", repo: m[2] ?? "", prNumber: parseInt(m[3] ?? "0", 10) };
}

function ghHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ripple-graph",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function ghJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`GitHub fetch failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** Failed-test files for a PR's head commit, straight from the check runs. */
export async function fetchCiTestFiles(ref: GhRef): Promise<CiExtraction> {
  const pr = await ghJson<{ head?: { sha?: string } }>(
    `${GH_API}/repos/${ref.owner}/${ref.repo}/pulls/${ref.prNumber}`,
  );
  const headSha = pr.head?.sha ?? "";
  if (!headSha) throw new Error(`PR #${ref.prNumber} has no head sha — is it still open?`);

  const checkRuns = await ghJson<
    Array<{ id: number; name?: string; conclusion?: string; details_url?: string }>
  >(`${GH_API}/repos/${ref.owner}/${ref.repo}/commits/${headSha}/check-runs?per_page=100`);

  const failedRuns = checkRuns.filter((r) => r.conclusion === "failure");
  const failed = new Set<string>();
  const fromRuns: string[] = [];
  const unparseableRuns: string[] = [];

  for (const run of failedRuns.slice(0, 10)) {
    let found = false;
    // annotations carry the actual failing file paths (2 pages max, 50/page)
    for (let page = 1; page <= 2; page++) {
      const annotations = await ghJson<Array<{ path?: string; message?: string }>>(
        `${GH_API}/repos/${ref.owner}/${ref.repo}/check-runs/${run.id}/annotations?per_page=100&page=${page}`,
      ).catch(() => [] as Array<{ path?: string; message?: string }>);
      for (const a of annotations) {
        if (!a.path) continue;
        if (!TEST_FILE_RE.test(a.path)) continue;
        const norm = normalizeTestPath(a.path);
        if (norm) {
          failed.add(norm);
          found = true;
        }
      }
      if (annotations.length < 100) break;
    }
    if (found) {
      if (run.details_url) fromRuns.push(run.details_url);
    } else if (failedRuns.length > 0) {
      unparseableRuns.push(run.name ?? String(run.id));
    }
  }

  return {
    label: `${ref.owner}/${ref.repo}#${ref.prNumber}`,
    headSha,
    failed: [...failed],
    fromRuns,
    unparseableRuns,
  };
}
