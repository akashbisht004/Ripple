/**
 * POST /api/ci-webhook — Phase 5's live landing point for CI events.
 *
 * Accepts either:
 *   1. GitHub `check_suite` (or `workflow_run`-less simple) webhook payloads —
 *      on a failing check suite we resolve the PR, pull the failing test files
 *      from check-run annotations, and feed the feedback loop, or
 *   2. a local/demo payload `{ label?, failed: [...], passed: [...] }` so the
 *      loop can be exercised without real CI (`curl` from the demo script).
 *
 * GitHub payloads are HMAC-verified when WEBHOOK_SECRET is configured.
 */
import { NextResponse } from "next/server";
import { disconnectGraph, graphSelector } from "@ripple/core";
import { recordCiResults, type CiRecordResult } from "@ripple/ci-feedback/feedback";
import { fetchCiTestFiles } from "@ripple/ci-feedback/github-ci";

export const runtime = "nodejs";

interface WebhookBody {
  failed?: string[];
  passed?: string[];
  label?: string;
  ref?: string;
  // github webhook payload subsets we consume
  check_suite?: { conclusion?: string; head_sha?: string; pull_requests?: Array<{ number: number }> };
  repository?: { full_name?: string };
  pull_request?: { number?: number };
  workflow_run?: { name?: string; conclusion?: string; head_branch?: string };
}

async function verifyGithubSignature(raw: string, header: string | null): Promise<boolean> {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return true; // not configured → accept
  if (!header) return false;
  const impl = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", impl, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return header === `sha256=${hex}`;
}

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text();
  if (!(await verifyGithubSignature(raw, req.headers.get("x-hub-signature-256")))) {
    return NextResponse.json({ ok: false, error: "signature verification failed" }, { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(raw) as WebhookBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }

  // ── GitHub check_suite event ─────────────────────────────
  if (body.check_suite && body.repository?.full_name) {
    const suites = body.check_suite;
    const prNumber = suites.pull_requests?.[0]?.number ?? body.pull_request?.number;
    const fullName = body.repository.full_name;
    const [owner, repo] = fullName.split("/");
    if (!prNumber || !owner || !repo) {
      return NextResponse.json({ ok: true, skipped: "check suite is not linked to a PR — nothing to score" });
    }
    if (suites.conclusion === "success") {
      return NextResponse.json({ ok: true, skipped: "check suite green — finding passed suites to decay against needs the test list; use --passed or the demo payload" });
    }
    if (suites.conclusion !== "failure") {
      return NextResponse.json({ ok: true, skipped: `conclusion "${suites.conclusion}" — nothing to score` });
    }
    const ci = await fetchCiTestFiles({ owner, repo, prNumber });
    const result = await score(body.ref ?? `checks on ${ci.headSha.slice(0, 8)}`, {
      label: ci.label,
      failed: ci.failed,
      passed: body.passed ?? [],
      source: "github",
    });
    return NextResponse.json({ ...result, ok: true }, { status: result.ok ? 200 : 422 });
  }

  // ── local / demo payload ─────────────────────────────────
  if (Array.isArray(body.failed) || Array.isArray(body.passed)) {
    const result = await score(body.ref ?? "webhook demo", {
      label: body.label,
      failed: body.failed ?? [],
      passed: body.passed ?? [],
      source: "manual",
    });
    return NextResponse.json({ ...result, ok: true }, { status: result.ok ? 200 : 422 });
  }

  return NextResponse.json({ ok: false, error: "unrecognized payload — expected a GitHub check_suite event or { failed, passed, label? }" }, { status: 400 });
}

async function score(ref: string, input: Parameters<typeof recordCiResults>[1]): Promise<CiRecordResult> {
  const { graph } = await graphSelector();
  try {
    return await recordCiResults(graph, { ...input, ref });
  } finally {
    await disconnectGraph();
  }
}
