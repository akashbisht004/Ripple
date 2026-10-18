/**
 * POST /api/comment — the optional Phase 4 PR comment bot.
 * Body: { prUrl: string, markdown: string }
 * Posts the rendered report as a structured GitHub PR comment.
 */
import { NextResponse } from "next/server";
import { prUrlToRef } from "@ripple/agent/github/pr-fetcher";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  const { prUrl, markdown } = (await req.json().catch(() => ({}))) as {
    prUrl?: string;
    markdown?: string;
  };
  const ref = prUrl ? prUrlToRef(prUrl) : null;
  if (!ref || !markdown?.trim()) {
    return NextResponse.json({ ok: false, error: "A valid PR URL and non-empty report are required" }, { status: 400 });
  }
  if (!process.env.GITHUB_TOKEN) {
    return NextResponse.json({ ok: false, error: "GITHUB_TOKEN is not set — cannot comment on the PR" }, { status: 401 });
  }

  const res = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.prNumber}/comments`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "User-Agent": "ripple-graph",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ body: `## 🌊 RIPPLE impact report\n\n${markdown}` }),
  });

  if (!res.ok) {
    return NextResponse.json({ ok: false, error: `GitHub comment failed (${res.status}): ${(await res.text()).slice(0, 200)}` }, { status: 502 });
  }
  const created = (await res.json()) as { html_url?: string };
  return NextResponse.json({ ok: true, url: created.html_url });
}
