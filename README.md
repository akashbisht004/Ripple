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

📄 **Full architecture, graph schema, and phased plan:** [`docs/implementation.md`](docs/implementation.md)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker (for FalkorDB)

### Run it

```bash
# 1. Start FalkorDB
docker compose up -d

# 2. Install dependencies
npm install

# 3. Ingest a repo into the graph (parse + git history)
npm run ingest -- --repo /path/to/repo

# 4. Analyze a PR from the CLI
npm run analyze -- --pr https://github.com/owner/repo/pull/123

# 5. Open the UI
npm run dev --workspace apps/web
```

### Configuration

Copy `.env.example` to `.env` and set:

```
FALKORDB_URL=redis://localhost:6379
GITHUB_TOKEN=your-github-token
LLM_API_KEY=your-llm-key
```

## Roadmap

| Phase | Milestone | Status |
|---|---|---|
| 1 | Ingestion pipeline → FalkorDB populated | 📋 planned |
| 2 | Git + GitHub history enrichment | 📋 planned |
| 3 | Analyzer + tool-calling agent + CLI report | 📋 planned |
| 4 | Next.js UI + ripple visualization | 📋 planned |
| 5 | CI feedback loop | 📋 planned |

See [`docs/implementation.md`](docs/implementation.md) for task-level detail.

## Team

Built with ⚡ for the hackathon — sponsored-track project for **FalkorDB**.

---

*RIPPLE: every change creates waves. See them before they hit production.*
