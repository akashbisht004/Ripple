/**
 * PR fetcher — Phase 3.
 *
 * Produces the "changed files" input for the impact engine from any of:
 *   --pr  <github PR url>          GitHub REST API (octokit-free, plain fetch)
 *   --files <a,b,c>                explicit list (offline demo mode)
 *   --diff <unified-diff file>     parse a local .patch/.diff
 *
 * No graph access in here — pure input resolution.
 */
import { readFileSync } from "node:fs";

export interface ChangedFile {
  path: string;
  /** GitHub status: added | modified | removed | … */
  status: string;
}

export interface PrInput {
  source: "github" | "files" | "diff";
  repo?: { owner: string; repo: string };
  prNumber?: number;
  label: string;
  files: ChangedFile[];
  prTitle?: string;
}

export interface PullRequestMeta {
  title: string;
  author: string;
  base: string;
  head: string;
}

const GH_API = "https://api.github.com";

export async function fetchPullRequestMeta(
  ref: { owner: string; repo: string; prNumber: number },
): Promise<PullRequestMeta> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ripple-graph",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${GH_API}/repos/${ref.owner}/${ref.repo}/pulls/${ref.prNumber}`, { headers });
  if (!res.ok) throw new Error(`GitHub PR fetch failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const pr = (await res.json()) as {
    title?: string;
    user?: { login?: string };
    base?: { ref?: string };
    head?: { ref?: string };
  };
  return {
    title: pr.title ?? "",
    author: pr.user?.login ?? "",
    base: pr.base?.ref ?? "",
    head: pr.head?.ref ?? "",
  };
}

export async function fetchPrFiles(
  ref: { owner: string; repo: string; prNumber: number },
): Promise<ChangedFile[]> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ripple-graph",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const out: ChangedFile[] = [];
  let page = 1;
  // files endpoint paginates at 30/page
  while (page <= 5) {
    const res = await fetch(
      `${GH_API}/repos/${ref.owner}/${ref.repo}/pulls/${ref.prNumber}/files?page=${page}&per_page=100`,
      { headers },
    );
    if (!res.ok) throw new Error(`GitHub PR files fetch failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const batch = (await res.json()) as Array<{ filename?: string; previous_filename?: string; status?: string }>;
    for (const f of batch) {
      if (f.filename) out.push({ path: f.filename, status: f.status ?? "modified" });
      if (f.previous_filename) out.push({ path: f.previous_filename, status: "renamed-away" });
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return distinct(out);
}

export function prUrlToRef(url: string): { owner: string; repo: string; prNumber: number } | null {
  const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/pull(?:.s)?\/(\d+)/.exec(url.trim());
  if (!m) return null;
  return { owner: m[1] ?? "", repo: m[2] ?? "", prNumber: parseInt(m[3] ?? "0", 10) };
}

/** `--files mode1.ts,mode2.ts` */
export function filesArgToPrInput(list: string): PrInput {
  const files = list
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((path) => ({ path, status: "modified" as const }));
  if (files.length === 0) throw new Error("--files was given but no paths were parsed");
  return { source: "files", label: "explicit file list", files };
}

/** Parse a unified diff for changed paths (dev/null-safe). */
export function diffFileToPrInput(diffPath: string): PrInput {
  const raw = readFileSync(diffPath, "utf8");
  const files = distinct(
    [...raw.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)]
      .map((m) => (m[1] ?? "").trim())
      .filter((p) => p && p !== "/dev/null")
      .map((path) => ({ path, status: "modified" as const })),
  );
  if (files.length === 0) throw new Error(`No changed files parsed from ${diffPath}`);
  return { source: "diff", label: `diff: ${diffPath}`, files };
}

export async function fetchPrInput(
  ref: { owner: string; repo: string; prNumber: number },
): Promise<PrInput> {
  const files = await fetchPrFiles(ref);
  return {
    source: "github",
    repo: { owner: ref.owner, repo: ref.repo },
    prNumber: ref.prNumber,
    label: `${ref.owner}/${ref.repo}#${ref.prNumber}`,
    files,
  };
}

function distinct(files: ChangedFile[]): ChangedFile[] {
  const seen = new Set<string>();
  return files.filter((f) => f.path && !seen.has(f.path) && (seen.add(f.path), true));
}
