"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalyzeError, AnalyzeResponse } from "@/lib/api-types";
import RippleGraph from "@/components/RippleGraph";
import EvidencePanel from "@/components/EvidencePanel";
import ReportView from "@/components/ReportView";
import RecentAnalyses from "@/components/RecentAnalyses";
import { renderMarkdown } from "@ripple/agent/analyze/report";
import type { AnalysisOutput } from "@ripple/agent/analyze/agent";
import type { AnalysisSummary } from "@/app/api/analyses/route";

const LOADING_STAGES = [
  "connecting to FalkorDB…",
  "fetching changed files…",
  "validating paths against the graph…",
  "rippling 4 hops through imports & calls…",
  "mining bug history from git…",
  "consulting the LLM agent…",
];

export default function RippleDashboard() {
  const [mode, setMode] = useState<"pr" | "files">("pr");
  const [prUrl, setPrUrl] = useState("");
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState("src/billing.ts");
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalyzeResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [recent, setRecent] = useState<AnalysisSummary[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshRecent = useCallback(async () => {
    try {
      const res = await fetch("/api/analyses", { cache: "no-store" });
      const json = (await res.json()) as { ok: boolean; analyses?: AnalysisSummary[] };
      if (json.ok && json.analyses) setRecent(json.analyses);
    } catch {
      /* history panel is non-critical */
    }
  }, []);

  useEffect(() => {
    void refreshRecent();
  }, [refreshRecent]);

  useEffect(() => {
    if (!loading) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }
    setStage(0);
    timerRef.current = setInterval(() => {
      setStage((s) => (s + 1) % LOADING_STAGES.length);
    }, 1700);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [loading]);

  const run = useCallback(
    async (overrides?: { mode?: "pr" | "files"; files?: string }) => {
      const effMode = overrides?.mode ?? mode;
      const effFiles = overrides?.files ?? files;
      setError(null);
      setData(null);
      setSelected(null);
      setLoading(true);
      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            effMode === "pr"
              ? { prUrl: prUrl.trim(), title: title.trim() || undefined }
              : { files: effFiles.trim(), title: title.trim() || undefined },
          ),
        });
        const json = (await res.json()) as AnalyzeResponse | AnalyzeError;
        if (!res.ok || !json.ok) {
          setError((json as AnalyzeError).error ?? `Request failed (${res.status})`);
          return;
        }
        const out = json as AnalyzeResponse;
        setData(out);
        void refreshRecent();
        // pre-select the riskiest node so the evidence panel starts populated
        const top =
          [...out.result.direct, ...out.result.ripple].find((i) => i.severity === "high") ??
          out.result.direct[0] ??
          out.result.ripple[0];
        if (top) setSelected(top.key);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [mode, prUrl, title, files, refreshRecent],
  );

  return (
    <div>
      <form
        className="analyze-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!loading) void run();
        }}      >
        <div className="mode-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "pr"}
            className={`mode-tab ${mode === "pr" ? "active" : ""}`}
            onClick={() => setMode("pr")}
          >
            GitHub PR
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "files"}
            className={`mode-tab ${mode === "files" ? "active" : ""}`}
            onClick={() => setMode("files")}
          >
            Changed files (offline)
          </button>
        </div>
        <div className="form-body">
          <div className="form-row">
            {mode === "pr" ? (
              <input
                className="input"
                value={prUrl}
                onChange={(e) => setPrUrl(e.target.value)}
                placeholder="https://github.com/owner/repo/pull/123"
                spellCheck={false}
              />
            ) : (
              <input
                className="input"
                value={files}
                onChange={(e) => setFiles(e.target.value)}
                placeholder="src/billing.ts, src/checkout.ts (comma-separated, relative to ingested repo)"
                spellCheck={false}
              />
            )}
            <input
              className="input input-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="optional: change title"
              style={{ flex: "0 1 240px" }}
              spellCheck={false}
            />
            <button className="run-btn" disabled={loading}>
              {loading ? "Rippling…" : "🌊 Analyze"}
            </button>
          </div>
          <p className="hint">
            Requires a repo ingested first (<code>npm run ingest -- --repo path/to/repo</code>) and FalkorDB up (<code>npm run db:up</code>
            ). Files mode is relative to the ingested checkout — try <code>src/billing.ts</code> on the bundled <code>samples/demo-ts-repo</code>.
          </p>
        </div>
      </form>

      <RecentAnalyses
        analyses={recent}
        disabled={loading}
        onRerun={(a) => {
          const filesStr = a.changedFiles.join(", ");
          setMode("files");
          if (filesStr) setFiles(filesStr);
          void run({ mode: "files", files: filesStr || undefined });
        }}
      />

      {loading && (
        <div className="loading">
          <div className="ripple-anim" aria-hidden>
            <span />
            <span />
            <span />
            <span />
          </div>
          <div className="loading-status">{LOADING_STAGES[stage]}</div>
        </div>
      )}

      {!loading && error && (
        <div className="card error-box">
          <strong>✖ Analysis failed.</strong> {error}
        </div>
      )}

      {data && <Result key={data.analysisKey} data={data} prUrl={prUrl.trim()} selected={selected} onSelect={setSelected} />}
    </div>
  );
}

function Result({
  data,
  prUrl,
  selected,
  onSelect,
}: {
  data: AnalyzeResponse;
  prUrl: string;
  selected: string | null;
  onSelect: (k: string) => void;
}) {
  const { result } = data;
  const output: AnalysisOutput = {
    result,
    narrative: data.narrative,
    llmUsed: data.llmUsed,
    toolCalls: data.toolCalls,
  };
  const markdown = renderMarkdown(output);

  return (
    <div>
      <div className="result-head">
        <span className="result-title">{data.prTitle ?? data.label}</span>
        {data.prTitle && <code className="evidence-dim">{data.label}</code>}
        <span className="chip chip-medium">{result.direct.length} direct</span>
        <span className="chip">{result.ripple.length} ripple</span>
        <span className="chip">≤4 hops</span>
        {data.feedback.accuracy != null && (
          <span className="chip chip-feedback" title="CI feedback loop: confirmed vs verified FLAGGED predictions">
            🎯 {Math.round(data.feedback.accuracy * 100)}% verified accuracy
          </span>
        )}
        <span className="result-sub">
          analysis key <code>{data.analysisKey}</code> — every prediction below is a real graph path in FalkorDB
          {result.flaggedCount > 0 ? ` · ${result.flaggedCount} nodes flagged` : ""}
        </span>
      </div>

      <div className="analysis-grid">
        <div className="card graph-card">
          <RippleGraph data={data.graph} selected={selected} onSelect={onSelect} />
        </div>
        <div className="side-stack">
          <div className="card">
            <div className="subhead">{data.llmUsed ? "🤖 Agent narrative (LLM, tool-verified)" : "⚙️ Deterministic summary"}</div>
            <p className="narrative">{data.narrative}</p>
            <div className="action-row">
              <CopyButton markdown={markdown} />
              {data.source === "github" && prUrl && <PostToPrButton prUrl={prUrl} markdown={markdown} />}
            </div>
          </div>
          <EvidencePanel data={data} nodeKey={selected} />
        </div>
      </div>

      <ReportView data={data} selected={selected} onSelect={onSelect} />
    </div>
  );
}

function CopyButton({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="mini-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(markdown);
          setCopied(true);
          setTimeout(() => setCopied(false), 2200);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "✓ copied" : "⧉ Copy report"}
    </button>
  );
}

function PostToPrButton({ prUrl, markdown }: { prUrl: string; markdown: string }) {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">(prUrl ? "idle" : "done");
  const [note, setNote] = useState("");
  return (
    <button
      className="mini-btn"
      disabled={state === "working" || !prUrl}
      onClick={async () => {
        setState("working");
        try {
          const res = await fetch("/api/comment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prUrl, markdown }),
          });
          const json = (await res.json()) as { ok: boolean; url?: string; error?: string };
          if (json.ok) {
            setState("done");
            setNote(json.url ? "✓ posted" : "✓ posted");
          } else {
            setState("error");
            setNote(json.error ?? "failed");
          }
        } catch (err) {
          setState("error");
          setNote(err instanceof Error ? err.message : String(err));
        }
      }}
    >
      {state === "working" ? "posting…" : state === "error" ? `⚠ ${note}` : state === "done" && note ? note : "🐙 Post report to PR"}
    </button>
  );
}
