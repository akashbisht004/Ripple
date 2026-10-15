# RIPPLE — Graph-Powered Code Change Intelligence

> **Implementation Plan** — Hackathon project (main sponsor track: **FalkorDB**, Graph Database)

---

## 1. Project Context

### 1.1 The Problem

When a developer opens a pull request, reviewers struggle to answer the real question: **"What else could this change break?"**

- Code review today relies on the reviewer mentally tracing dependencies.
- A seemingly safe change to a utility function can silently break a downstream API, a UI component, or a cron job three layers away.
- Historical knowledge (e.g., *"this exact function caused a bug in 2023"*) is buried in commit history and issue trackers — nobody consults it during review.
- Past CI failures that already proved which tests matter for which code are never reused.

### 1.2 The Solution — RIPPLE

**RIPPLE** is an AI agent that analyzes a GitHub pull request and uses **FalkorDB** to build and traverse a graph of code dependencies, functions, APIs, tests, and historical bug fixes — then explains, with evidence, **why** a change might affect another part of the system.

### 1.3 Core Capabilities

| Capability | Description |
|---|---|
| **Dependency Mapping** | Parses the codebase (TypeScript Compiler API) and builds a graph of how parts of the codebase connect: files → functions → classes → API routes → types |
| **Impact Analysis** | Given changed files in a PR, traverses direct and indirect dependencies (reverse edges) to identify potentially affected components — the "ripple" |
| **Historical Context** | Connects changed code to previous bugs, commits, and related issues (e.g., `node→Bug` edges from git history and GitHub issues) |
| **Test Recommendations** | Suggests which tests to run for the change, and highlights coverage gaps (changed nodes with no incoming `COVERED_BY`/`TESTS` edge) |
| **Continuous Feedback** | When CI runs, records which predicted impacts were confirmed or disproven by failing/passing tests, weighting future analysis |

### 1.4 Core Differentiator

Unlike conventional AI coding assistants that reason only from the code and context pasted into a prompt, RIPPLE uses:

1. **Graph-based relationship traversal** (FalkorDB / Cypher) — multi-hop impact paths a plain-text prompt could never fit into context, and
2. **Historical evidence** — real bug-fix commits and past CI results attached as relationships in the graph.

The LLM doesn't guess impact — it *queries the graph* with tool calls and cites the paths and bug history as evidence.

### 1.5 Why FalkorDB (Sponsor Track)

FalkorDB is the heart of the project, not a bolted-on checkbox:

- **Sparse, evolving graph with fast traversals** — FalkorDB is purpose-built for exactly this: a large, sparsely-connected graph with variable-depth path queries (`[1..4]` hop traversals) that no SQL join explosion could handle.
- **Native Cypher query engine** — we model the codebase as a property graph (`File`, `Function`, `Class`, `ApiRoute`, `Type`, `Test`, `Bug`, `Commit`, `Issue` nodes) and answer review questions with Cypher path queries.
- **Full-text search + vector search in-engine** — FalkorDB supports full-text and vector indexes on nodes, so the agent can find candidate code entities semantically ("which functions deal with auth token validation?") *inside the same database it traverses*.
- **Client integration** — `falkordb` npm client (Redis-compatible protocol), runs locally via Docker for the hackathon demo.

### 1.6 Tech Stack

| Layer | Technology |
|---|---|
| Language / Runtime | TypeScript, Node.js |
| Graph database | **FalkorDB** (Cypher, via `falkordb` npm client, Docker) |
| Code parsing | TypeScript Compiler API (`ts-morph` or raw `typescript` API) |
| Codebase / PR data | GitHub API (octokit) — PR diffs, commits, issues |
| Git history mining | local git log + GitHub commits/issues linking to bugs |
| AI Agent | LLM with tool calling (agent queries FalkorDB via Cypher tools) |
| Web UI | Next.js (dashboard showing PR analysis, impact graph visualization, test plan) |
| CI feedback | GitHub Actions / webhook results written back into the graph |

---

## 2. Graph Schema (Design Target)

Core nodes and relationships we will create in FalkorDB:

```
(:File {path, hash})
(:Function {name, qualifiedName, line,… signature})
(:Class {name, qualifiedName, line})
(:ApiRoute {method, path})          // Next.js/HTTP endpoints
(:Type {name})
(:Test {name, file, status})        // last known status
(:Commit {sha, message, date})
(:Bug {id, title, url, severity})   // from issues/bug-fix commits
(:Issue {id, title, url, state})

(:File)-[:CONTAINS]->(:Function|Class|Type)
(:File)-[:DEPENDS_ON {symbolsUsed}]->(:File)      // import graph
(:Function|Class)-[:CALLS]->(:Function|Class)     // call graph
(:Function)-[:USES_TYPE]->(:Type)
(:Route)-[:HANDLED_BY]->(:Function)
(:File|Function)-[:TESTED_BY]->(:Test)
(:Commit)-[:TOUCHED]->(:File)
(:Commit)-[:FIXED]->(:Bug)
(:Bug|Issue)-[:REFERS_TO]->(:File|Function)
(:Commit)-[:AUTHORED_AT]->(repo history)
```

Example analysis queries (Cypher shapes we will use):

```cypher
-- 1. Everything transitively reachable FROM changed files (up to 3 hops)
MATCH (f:File {path:$path})-[r:CALLS|DEPENDS_ON*1..3]->(t)
WHERE t.path <> $path
RETURN labels(t)[0] AS kind, t.qualifiedName, length(r) AS hops, r

-- 2. Reverse ripple: who is affected downstream (callers / importers)
MATCH (src:File {path:$path})<-[:CALLS|DEPENDS_ON*1..4]-(affected)
RETURN affected.qualifiedName, length(*) AS depth ORDER BY depth

-- 3. Historical: was this function previously involved in a bug?
MATCH (fn:Function {qualifiedName:$qn})<-[:REFERS_TO]-(b:Bug)<-[:FIXED]-(c:Commit)
RETURN c.sha, c.message, b.title ORDER BY c.date DESC

-- 4. Test recommendation: tests transitively covering changed code
MATCH (f:File {path:$path})<-[:CONTAINS]-(n)-[:TESTED_BY]->(t:Test)
RETURN t.name, t.file
-- + coverage gap: changed nodes with no path to any :Test
```

---

## 3. Architecture

### 3.1 High-Level Component Diagram

```
                                          ┌─────────────────────────┐
                                          │      apps/web (Next.js) │
                                          │  PR input · Ripple graph │
                                          │  Report view · Evidence  │
                                          └───────────▲─────────────┘
                                                      │ (server action / API route)
┌──────────────────┐   PR diff,         ┌────────────┴────────────┐        ┌──────────────────┐
│   GitHub API     │  files, commits    │   packages/agent        │        │ packages/ingest  │
│   (octokit)      ├───────────────────►│   ┌───────────────────┐ │        │  TS Compiler API │
│                  │                    │   │  LLM w/ tool call │ │        │  git history miner│
└──────────────────┘                    │   └───────┬───────────┘ │        └────────┬─────────┘
                            │           tools: Cypher queries            │
        CI results          │                       │                    │
┌──────────────────┐        │           ┌───────────▼───────────┐        │
│  GitHub Actions  │        │           │   FalkorDB (Docker)   │◄───────┘
│  / CI webhook    ├────────┴──────────►│   property + evidence │        parse files,
│  test results    │   write-back        │   graph, FTS + vector │        imports, calls,
└──────────────────┘                     │   indexes             │        commits, bugs
                                         └───────────────────────┘
```

### 3.2 Monorepo / Module Layout

```
ripple/
├── packages/
│   ├── core/          # FalkorDB client singleton, schema constants, graph writer (batched MERGE), indexes
│   ├── ingest/        # TS Compiler API parser (files/imports/calls), git history miner, ingestion orchestrator (one command: `npm run ingest`)
│   ├── agent/         # LLM agent: tool definitions (Cypher-backed), PR fetcher (octokit), impact engine, report generator
│   └── ci-feedback/   # CI webhook listener: writes confirmed/disproven outcomes back as graph edges
├── apps/
│   └── web/           # Next.js app: PR input, ripple graph visualization, evidence panel, report view
├── docker-compose.yml # FalkorDB container
└── docs/
```

Module dependency rules (keep it clean): `ingest`, `agent`, `ci-feedback`, `web` all depend on `core`; nothing depends on `agent` except `web`. The impact engine in `agent` stays a pure function set (no DB calls) so it is unit-testable; the agent wraps it and fetches evidence via `core`.

### 3.3 Data Flow

**A. Ingestion (bulk, run once per repo / re-run on refresh)**

1. `ingest` walks the repo (skipping `node_modules`), parses each file with the TS Compiler API → `File`, `Function`, `Class`, `Type`, `ApiRoute` nodes + `DEPENDS_ON` / `CALLS` / `CONTAINS` edges → batch-written via `core` graph writer.
2. Git miner walks `git log` → `Commit` nodes, `TOUCHED` edges; bug-fix heuristic (message regex `Fix|Bug|Issue|Regression` + `#\d+`) → `Bug` nodes + `FIXED` / `REFERS_TO` edges.
3. Test files are tagged as `Test` nodes and linked via `TESTED_BY` edges (name/path convention: `*.test.ts`, `*.spec.ts`).
4. Full-text (and vector) indexes created on code entities inside FalkorDB.

**B. PR analysis (per PR, the demo flow)**

1. User submits a PR URL → `agent` fetches changed files + diffs via octokit.
2. Impact engine computes the ripple: direct impacts (changed symbols) → indirect impacts via reverse Cypher traversal (`*1..4` hops), scores by `hop-count × edge weight`, classifies severity (bug history present / route reachable / fan-in count).
3. The LLM agent, given the changed files, **calls tools** (`bug_history`, `find_tests`, `coverage_gaps`, `search_code_semantic`) which each execute Cypher against FalkorDB — the agent reasons over returned rows, cites paths + evidence, and emits the structured report.
4. Report is persisted as `(:Analysis)-[:FLAGGED]->` impact nodes and rendered in the web UI as the ripple graph + evidence panel.

**C. Continuous feedback (per CI run)**

1. CI webhook delivers test results for the PR.
2. `ci-feedback` matches failing tests to previously flagged impact nodes → strengthens `FLAGGED` confidence; repeatedly-passing predictions decay. Future analyses read this weighting.

### 3.4 Key Design Decisions

| Decision | Rationale |
|---|---|
| Cypher at the tool boundary | Every agent tool is a named Cypher query against FalkorDB — the DB does the real work (sponsor-track credibility) and the agent never invents relationships |
| Pure impact engine + evidence-fetching agent | Deterministic traversal for the candidate set; LLM adds explanation, prioritization, and plain-English summary on top | 
| Batched MERGE ingestion with upsert semantics | Re-ingesting an updated repo updates nodes/edges instead of duplicating; keeps demo re-runs cheap |
| Persisted `:Analysis` runs | Required for the Phase 5 feedback loop — predictions must be addressable later |
| `core` as the only DB accessor | One place for connection handling, retry, and index creation; all modules share it |
| Parser behind an interface | TS-only at first, but `Parser` interface lets other languages join without schema changes |

---

## 4. Phased Implementation Plan

We implement the hackathon project in **5 phases**. Each phase ends with something demoable. Phases 1–3 are the MVP; Phases 4–5 are the wow-factor.

---

### **Phase 1 — Foundation: FalkorDB ingestion pipeline** (MVP core)

**Goal:** Parse a real TypeScript repo and load its structure as a graph in FalkorDB.

**Tasks**
- [ ] Project scaffold: TypeScript + Node.js, ESLint, tsconfig; monorepo layout (`packages/ingest`, `packages/agent`, `apps/web`)
- [ ] FalkorDB setup: `docker-compose.yml` with FalkorDB container + `falkordb` npm client singleton with health check
- [ ] Graph writer module: batched Cypher `CREATE`/`MERGE` helpers (upsert semantics so re-ingestion updates rather than duplicates; create index on `qualifiedName`, `path`)
- [ ] Parser using **TypeScript Compiler API**: extract per-file — imports (`DEPENDS_ON` with `symbolsUsed` on edge), exported functions/classes/types, and internal call expressions (`CALLS`)
- [ ] After ingestion, the graph schema above is present in the DB.

**Demo milestone:** Query FalkorDB with Cypher manually (or a small CLI script) and see the dependency graph of a sample repo.

**Risk notes:** Fasten ingestion now (it runs at demo time); handle resolve of `paths`/`baseUrl` aliases; skip `node_modules`.

---

### **Phase 2 — Git + GitHub history enrichment**

**Goal:** Turn the pure code graph into an *evidence* graph by adding commits, bugs, and issues.

**Tasks**
- [ ] Ingest git history: for each commit `TOUCHED` its files; detect bug-fix commits (message contains `Fix|Bug|Issue|Regression` + issue number regex) → `(:Commit)-[:FIXED]->(:Bug)`
- [ ] Confirm changed files actually became nodes: post-ingestion, each commit `sha` → set of `paths`: `(c:Commit)-[:TOUCHED]->(f:File)` matched by path and not padded

**Demo milestone:** Ask "was this function ever involved in a bug?" by running Cypher #3 and getting real Evidence rows with issue URLs.

---

### **Phase 3 — Analyzer + agent (the brain)**

**Goal:** Build the analysis engine: given a PR, run impact analysis and produce a report, with an LLM agent that queries the graph via tools.

**Tasks**
- [ ] **PR fetcher** via GitHub API (octokit): fetch PR files + patch ranges, map to repo files (and sym — `affected`)
- [ ] **Impact engine** (pure functions):
  - Direct impacts: changed functions/classes + symbols exported from changed files
  - Indirect (the ripple): Cypher #1 & #2 above, computed per change; dedupe and score by path (`hop-count × edge-type weight`)
  - Severity classification: `high` (bug history present OR API route reachable), `medium` (3+ inbound paths), `low`
- [ ] **Tool-calling agent** (LLM):
  - Tools: `impact_analysis(files)`, `bug_history(qualifiedName)`, `find_tests(files)`, `coverage_gaps(files)`, `search_code_semantic(query)` (FalkorDB full-text/vector index)
  - System prompt: "Query the graph with tools, NEVER guess relationships; cite hops and evidence"
  - Output: structured JSON report `{impacted[], historicalEvidence[], testPlan[], coverageGaps[], summary}`
- [ ] **Test recommendation**: map changed nodes → `TESTED_BY` tests to run; list changed code with NO test path as coverage gaps
- [ ] Persist the analysis run: `(:Analysis {pr, createdAt, scores} )-[:FLAGGED {hopDepth, confidence}]->(impacted nodes)` (needed by Phase 5)

**Demo milestone:** CLI (`npm run analyze -- --pr <url>`) prints a Markdown impact report with cited Cypher evidence.

---

### **Phase 4 — Next.js web UI + visualization**

**Goal:** Make the analysis beautiful and reviewable in the browser.

**Tasks**
- [ ] Next.js app (App Router): PR input → runs analyzer (server action / API route)
- [ ] **Interactive graph visualization** of the ripple: force-directed or layered (top-down by hop depth) — changed file highlighted as origin, ripple outward with edge types; clicking a node shows evidence panel (bug history, commits, test status). Use a JS graph renderer (e.g., `reactflow` / `reagraph` / `sigma.js` — pick during build)
- [ ] Report view: severity-grouped impacted components, test plan with checkboxes, coverage gaps callouts
- [ ] Optional: PR comment bot — post the report as a structured comment on the PR via GitHub API

**Demo milestone:** Open browser, submit a PR URL, see the animated ripple graph + evidence side panel. **This is the main demo.**

---

### **Phase 5 — Continuous feedback loop (visitors' wow-factor)**

**Goal:** Close the loop — RIPPLE gets better with every CI run.

**Tasks**
- [ ] Ingest CI test results: `(:AnalysisRun)` predictions vs actual CI outcome
- [ ] Confirmed impact: predicted-affected component's test failed → strengthen edge weight / up-vote pattern
- [ ] Disproven: predicted but tests passed repeatedly → decay confidence
- [ ] Surface in report: "3 of the top-5 predicted impacts were confirmed in the last 3 CI runs" + historical accuracy badge per repo
- [ ] Live demo script: push a breaking change, show CI webhook landing, graph nodes flagged/confirmed in UI

**Demo milestone:** Second run on the same repo shows *improved, tightened predictions*, and the UI shows the feedback loop.

---

## 5. Timeline (hackathon days)

| Days | Phase | Output |
|---|---|---|
| Day 1 | Phase 1 | Ingestion → FalkorDB populated |
| Day 2 | Phase 2 | History enrichment |
| Day 3 | Phase 3 | Analyzer + agent + CLI report |
| Day 4 | Phase 4 | Next.js UI + ripple visualization |
| Day 5 | Phase 5 | CI feedback loop + demo polish |

(We can overlap 2 and 3 in parallel — ingestion and agent are independent once the schema is stable.)

---

## 6. MVP Cut & Fallback

**If time is short, the MVP is Phase 1 + 3 + minimal Phase 4** (CLI can even stand in for a UI). In that case:
- Git history from **local `git log`** only (skip GitHub Issues)
- Agent uses **2–3 tools max** (impact, bug history, tests)
- UI: **single static report page**, no graph animation

## 7. Open Questions / To Decide

1. LLM provider preference (OpenAI / Anthropic / other)? → recommended helper extraction of provider config to `.env`.
2. Repo scale for demo — pick a demo repo of **~50–200 files** so the graph and UI look rich, but traversal stays snappy.
3. Graph visualization library choice (decide in Phase 4 kickoff).
4. Language scope: TS-only at first (matches Compiler API); the design keeps a `Parser` interface so other languages could join later without schema changes.

---

## 8. Success Criteria (hackathon POV)

- [ ] A repo ingested end-to-end into FalkorDB in one command
- [ ] A PR analyzed in < 60 s with a full ripple path + historical evidence
- [ ] The UI shows the impact graph with evidence on click
- [ ] At least one "confirmed prediction" story told live in the demo (Phase 5)
- [ ] Every claim in the report is backed by a queryable graph path (sponsor-track credibility: FalkorDB is doing real work)
