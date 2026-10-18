# RIPPLE 🔀

> **Graph-Powered Code Change Intelligence** — know *what could break* before you merge.

RIPPLE is an AI agent that analyzes a GitHub pull request and uses **FalkorDB** to build and traverse a graph of code dependencies, functions, APIs, tests, and historical bug fixes — then explains, with evidence, **why** a change might affect another part of the system.

Built for the hackathon's **FalkorDB (Graph DB) sponsor track**.

---

## The Problem

When a developer opens a PR, reviewers struggle to answer the real question: *"What else could this change break?"*

- A "safe" change to a utility function can silently break a downstream API three layers away.
- Historical knowledge — *"this exact function caused a bug last year"* — is buried in commit history and issues, and nobody consults it during review.
- CI results that already proved which tests matter for which code are never reused.

## How It Works

1. **Ingest** — Parse the codebase with the TypeScript Compiler API and load it into FalkorDB as a property graph: files → functions → classes → API routes → types, plus call and import edges.
2. **Enrich** — Mine git history and GitHub issues: commits that touched files, bug-fix commits, and linked bugs become graph nodes and relationships — an *evidence* graph.
3. **Analyze** — For a PR, run graph traversals (reverse ripple over 1–4 hops) to find impacted components, attach severity, and pull matching bug history and tests.
4. **Explain** — An LLM agent with **tool calling** queries FalkorDB via Cypher tools (`impact_analysis`, `bug_history`, `find_tests`, …) and cites graph paths as evidence. It never guesses relationships — it queries them.
5. **Learn** — CI test results are written back: confirmed predictions gain confidence, disproven ones decay. RIPPLE gets better with every merge.

## Features

- 🔁 **Dependency mapping** — full import + call graph of the codebase in FalkorDB
- 🌊 **Impact analysis** — direct and indirect ("ripple") impacts from changed PR files, scored by hop depth and severity
- 🐞 **Historical context** — previous bugs, fix commits, and issues tied to the changed code
- 🧪 **Test recommendations** — which tests to run, plus coverage gaps (changed code with no test path)
- 📈 **Continuous feedback** — CI results confirm/disprove predictions, weighting future analyses
- 🧭 **Interactive UI** — Next.js dashboard with a visual ripple graph and an evidence panel

## Why FalkorDB?

FalkorDB is the heart of the project, not a bolted-on database:

- Purpose-built for **large, sparse graphs with fast multi-hop traversals** (`*1..4`) — exactly what "trace the ripple" needs.
- Native **Cypher** query engine over a property graph of code entities.
- **Full-text + vector search in-engine** — semantic code search inside the same database we traverse.
- Clean integration via the [`falkordb`](https://github.com/FalkorDB/falkordb-nodejs) npm client, running locally in Docker.

## Tech Stack

| Layer | Technology |
|---|---|
| Language / Runtime | TypeScript, Node.js |
| Graph database | **FalkorDB** (Cypher, Docker) |
| Code parsing | TypeScript Compiler API |
| PR / repo data | GitHub API (octokit) |
| AI agent | LLM with tool calling (Cypher-backed tools) |
| Web UI | Next.js |

## Architecture

```
GitHub API ──PR/commits──► packages/agent ──Cypher tools──► FalkorDB
     ▲                          ▲                              ▲
CI webhook ──results──► ci-feedback                    packages/ingest
                               │                    (TS Compiler API + git)
                        apps/web (Next.js) ◄── report + ripple graph
```

- **`packages/ingest`** — parses the repo (imports, calls, tests) and git history into the graph
- **`packages/agent`** — PR fetcher, impact engine, LLM agent with Cypher tools
- **`packages/ci-feedback`** — writes confirmed/disproven CI outcomes back as graph edges
- **`apps/web`** — Next.js UI: ripple graph visualization + evidence panel

## How to Use

### 0. Prerequisites

- Node.js 20+ (`node -v`)
- Docker Desktop, running (hosts FalkorDB)

### 1. Setup

```bash
# start FalkorDB (host 6380 → container 6379, volumes persist the graph)
docker compose up -d

# install all workspaces
npm install

# configure — then edit .env
cp .env.example .env
```

```
FALKORDB_HOST=localhost
FALKORDB_PORT=6380        # docker-compose maps host 6380 → container 6379
FALKORDB_GRAPH=ripple
GITHUB_TOKEN=             # optional: private PRs, issues hydration, PR comment bot
LLM_PROVIDER=openrouter   # openrouter | ollama
LLM_MODEL=openai/gpt-4o-mini
OPENROUTER_API_KEY=       # optional: LLM narrative (report is deterministic without it)
WEBHOOK_SECRET=           # optional, HMAC for the CI feedback webhook
```

No LLM key? Everything still works — the report falls back to a deterministic mode. (Ollama: `LLM_PROVIDER=ollama`, `LLM_MODEL=llama3.1`.)

### 2. Ingest a repo into the graph

```bash
# the bundled demo repo — safe default (fresh clone: restore its git history first)
npm run demo:seed                                   # one-time, after a fresh clone
npm run ingest -- --repo ./samples/demo-ts-repo

# your own TypeScript repo (local checkout; git history is mined too)
npm run ingest -- --repo /path/to/repo

# options
npm run ingest -- --repo <path> --reset          # wipe the graph first
npm run ingest -- --repo <path> --github         # hydrate Bug nodes from GitHub issues
```

Re-running is an upsert — it updates in place, no duplicates.

### 3. Analyze a change

```bash
# a real GitHub PR (fetches changed files via GitHub API)
npm run analyze -- --pr https://github.com/owner/repo/pull/123

# offline demo mode: explicit changed paths (relative to the ingested repo)
npm run analyze -- --files src/billing.ts

# from a unified diff file (e.g. saved from GitHub)
npm run analyze -- --diff ./pr-123.patch
```

Every run prints a Markdown impact report — direct impacts, the ≤4-hop ripple, bug history with commit links, the test plan and coverage gaps — and persists `(:Analysis)-[:FLAGGED]->` predictions for the feedback loop.

### 4. The web UI

```bash
npm run dev          # → http://localhost:3000
```

1. Pick an input mode — **GitHub PR** (paste the URL) or **Changed files** (comma-separated paths, offline)
2. Hit **🌊 Analyze**
3. The **ripple graph** shows changed files at the origin, impacts orbiting outward on hop-depth rings, colored by severity (🔴/🟠/🟢), edges typed by relationship
4. **Click any node** → evidence panel: hop depth, discovery path, bug history with links, linked tests, CI-feedback weighting
5. Below: severity-grouped report, coverage gaps, interactive test-plan checklist, the **CI feedback loop** card (accuracy + last runs), and the **🕑 Recent analyses** panel — one-click **↻ re-run** of any past run
6. **⧉ Copy report** to clipboard, or **🐙 Post report to PR** as a GitHub comment

### 5. Close the loop — CI feedback

CI outcomes are written back onto the persisted predictions; the **next analysis reads that weighting** (confirmed → severity bump + score +2; disproven → decay, severity step-down).

```bash
# GitHub mode: pulls failed check runs + annotations for the PR head commit
npm run ci-feedback -- --pr https://github.com/owner/repo/pull/123

# manual mode: feed exactly what CI would report
npm run ci-feedback -- --failed src/auth.test.ts
npm run ci-feedback -- --failed src/auth.test.ts --passed src/billing.test.ts
```

Or the webhook:

```bash
curl -X POST http://localhost:3000/api/ci-webhook \
  -H "Content-Type: application/json" \
  -d '{"failed":["src/auth.test.ts"],"ref":"demo landing"}'
```

Also accepts real GitHub `check_suite` events (HMAC-verified when `WEBHOOK_SECRET` is set).

### The 60-second demo script

```bash
docker compose up -d                                 # 0. FalkorDB up
npm run demo:seed                                    # 1. demo repo history (fresh clone only)
npm run ingest -- --repo ./samples/demo-ts-repo      # 2. graph ready
npm run analyze -- --files src/billing.ts            # 2. baseline: billing = 🟠 medium, score 5
curl -X POST localhost:3000/api/ci-webhook \
  -H "Content-Type: application/json" \
  -d '{"failed":["src/auth.test.ts"]}'               # 3. CI "fails"
npm run analyze -- --files src/billing.ts            # 4. now 🟥 high, score 7, "🔁 confirmed ×1"
npm run dev                                          # 5. show the UI
```

### Tests (offline, no DB needed)

```bash
npm run test         # 15 unit tests: impact-engine scoring/severity + CI match logic
npm run typecheck    # all workspaces, incl. the test suites
```

## Roadmap

| Phase | Milestone | Status |
|---|---|---|
| 1 | Ingestion pipeline → FalkorDB populated | ✅ done |
| 2 | Git + GitHub history enrichment | ✅ done (diff hunks, function-level bug links, `--github` hydration) |
| 3 | Analyzer + tool-calling agent + CLI report | ✅ done (`npm run analyze`, LLM-ready with fallback) |
| 4 | Next.js UI + ripple visualization | ✅ done (App Router, hop-ring ripple graph, evidence panel, PR comment bot) |
| 5 | CI feedback loop | ✅ done (`npm run ci-feedback`, `/api/ci-webhook`, confirmed/decay weighting, accuracy badge) |
| 6 | Hardening & polish | ✅ done (unit tests via `npm run test`, live gap hunt with 2 fixes incl. FalkorDB fulltext procedure, recent-analyses history panel with re-run) |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `FalkorDB unreachable` | `docker compose up -d`; wait for `(healthy)` in `docker ps` |
| Empty report / `0 impacts` | the changed paths aren't in the graph — re-ingest the repo; paths must be repo-relative (`src/…`, not absolute) |
| `--pr` mode fails 401/403/404 | set `GITHUB_TOKEN` (repo scope) in `.env`, restart `npm run dev` |
| Narrative says "deterministic" | no LLM key set — add `OPENROUTER_API_KEY` (or `LLM_PROVIDER=ollama`) |
| Port 3000 busy | change the port in `apps/web/package.json` |
| Graph empty after restart | FalkorDB container was recreated without its volume — re-run ingest |

> Detailed internal docs (architecture deep-dive, phased plan) live locally in `docs/` — kept out of git for this repo.

## Team

Built with ⚡ for the hackathon — sponsored-track project for **FalkorDB**.

---

*RIPPLE: every change creates waves. See them before they hit production.*
