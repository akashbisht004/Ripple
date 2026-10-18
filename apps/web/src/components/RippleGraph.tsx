"use client";

/**
 * Interactive ripple visualization (Phase 4).
 *
 * The changed files sit at the origin; impacted nodes orbit outward on rings
 * by hop depth — literally the "ripple" that FalkorDB's reverse traversal
 * produced. Each ring is one BFS level from the impact engine; edges are the
 * real DEPENDS_ON / CALLS / HANDLED_BY / CONTAINS paths from the graph.
 *
 * Pure SVG — no graph-renderer dependency; layout is deterministic:
 * rings by depth, each ring's nodes rotated to fan out from their parents.
 */
import { useMemo } from "react";
import type { GraphEdge, GraphView } from "@/lib/api-types";

const EDGE_COLOR: Record<GraphEdge["type"], string> = {
  DEPENDS_ON: "#5b6b8c",
  CALLS: "#38bdf8",
  HANDLED_BY: "#a78bfa",
  CONTAINS: "#36435f",
};

const SEV_COLOR: Record<string, string> = {
  origin: "#94a3b8",
  high: "#f43f5e",
  medium: "#f59e0b",
  low: "#10b981",
};

const KIND_ICON: Record<string, string> = {
  File: "▤",
  Function: "λ",
  Class: "C",
  Type: "τ",
  ApiRoute: "↯",
  Test: "✓",
};

const RING_R = [46, 150, 258, 362, 462, 556]; // ring 0 = origin cluster, 1..5 = hop depth
const HALF = 660; // viewBox is -HALF..HALF

interface Pt {
  x: number;
  y: number;
}

export default function RippleGraph({
  data,
  selected,
  onSelect,
}: {
  data: GraphView;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const layout = useMemo(() => computeLayout(data), [data]);

  return (
    <div>
      <svg className="graph-svg" viewBox={`${-HALF} ${-HALF} ${HALF * 2} ${HALF * 2}`} role="img" aria-label="Ripple impact graph">
        <defs>
          {Object.entries(EDGE_COLOR).map(([type, color]) => (
            <marker key={type} id={`arr-${type}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill={color} />
            </marker>
          ))}
          <radialGradient id="origin-glow">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* faint hop rings with labels */}
        {RING_R.map((r, i) =>
          i === 0 ? null : (
            <g key={r}>
              <circle r={r} fill="none" stroke="#182338" strokeWidth="1" strokeDasharray="3 7" />
              <text x={4} y={-r - 5} fill="#3d4d6f" fontSize="10" fontFamily="ui-monospace, Consolas, monospace">
                hop {i}
              </text>
            </g>
          ),
        )}

        {/* expanding pulse — the "ripple" */}
        {[0, 4.5].map((begin) => (
          <circle key={begin} cx="0" cy="0" r="10" fill="none" stroke="#38bdf8" strokeWidth="1.5">
            <animate attributeName="r" from="14" to={556} dur="7s" begin={`${begin}s`} repeatCount="indefinite" />
            <animate attributeName="opacity" from="0.5" to="0" dur="7s" begin={`${begin}s`} repeatCount="indefinite" />
          </circle>
        ))}

        {/* center glow */}
        <circle r="70" fill="url(#origin-glow)" />

        {/* edges */}
        {layout.edges.map((e) => {
          const a = layout.pos.get(e.src);
          const b = layout.pos.get(e.dst);
          if (!a || !b) return null;
          const isSel = selected != null && (e.src === selected || e.dst === selected);
          const dim = selected != null && !isSel;
          const curved = curveBetween(a, b);
          return (
            <path
              key={`${e.src}|${e.type}|${e.dst}`}
              d={curved.d}
              fill="none"
              stroke={EDGE_COLOR[e.type]}
              strokeWidth={isSel ? 2 : 1.1}
              opacity={dim ? 0.14 : isSel ? 0.95 : 0.6}
              markerEnd={`url(#arr-${e.type})`}
              className="edge-in"
              style={{ strokeDasharray: "220", animationDelay: `${(layout.ringOf.get(e.dst) ?? 0) * 0.14}s` }}
            />
          );
        })}

        {/* nodes */}
        {layout.nodes.map((n) => {
          const p = layout.pos.get(n.key);
          if (!p) return null;
          const sev = n.origin ? "origin" : n.severity ?? "low";
          const color = SEV_COLOR[sev] ?? SEV_COLOR.low;
          const r = n.origin ? 27 : n.kind === "File" ? 25 : n.kind === "ApiRoute" ? 22 : 19;
          const isSel = n.key === selected;
          const dim = selected != null && !isSel && !layout.adjacent.has(n.key);
          const ring = layout.ringOf.get(n.key) ?? 0;
          return (
            <g
              key={n.key}
              className={`graph-node ${isSel ? "selected" : ""}`}
              transform={`translate(${p.x} ${p.y})`}
              opacity={dim ? 0.35 : 1}
              onClick={() => onSelect(n.key)}
            >
              <g className="node-in" style={{ animationDelay: `${ring * 0.14}s` }}>
                {isSel && <circle r={r + 8} fill="none" stroke={color} strokeWidth="1.4" strokeDasharray="4 6" opacity="0.85" />}
                <circle className="n-body" r={r} fill={color} fillOpacity={n.origin ? 0.22 : 0.16} stroke={color} strokeWidth={isSel ? 2.4 : 1.6} />
                <text y="4" textAnchor="middle" fontSize={r * 0.62} fontWeight="700" fill={color} fontFamily="ui-monospace, Consolas, monospace">
                  {KIND_ICON[n.kind] ?? "●"}
                </text>
                <title>
                  {`${n.key}\n${n.kind}${n.origin ? " · changed (origin)" : ring > 0 ? ` · hop ${ring}` : " · direct"}${sev ? ` · ${sev}` : ""}`}
                </title>
                <text
                  y={r + 14}
                  textAnchor="middle"
                  fontSize="10.5"
                  fill={isSel ? "#dbe4f5" : "#7385a8"}
                  fontFamily="ui-monospace, Consolas, monospace"
                >
                  {clip(n.name, 34)}
                </text>
              </g>
            </g>
          );
        })}
      </svg>

      {data.truncated && <div className="truncation-note">⚠ ripple truncated to the highest-score nodes</div>}

      <div className="graph-legend">
        {(["origin", "high", "medium", "low"] as const).map((s) => (
          <span key={s}>
            <span className="legend-swatch" style={{ background: SEV_COLOR[s] }} />
            {s === "origin" ? "changed (origin)" : s}
          </span>
        ))}
        <span style={{ borderLeft: "1px solid var(--line)", paddingLeft: 12 }} />
        {Object.entries(EDGE_COLOR).map(([t, c]) => (
          <span key={t}>
            <span className="legend-swatch" style={{ background: c, borderRadius: 2 }} />
            {t}
          </span>
        ))}
        <span style={{ marginLeft: "auto" }}>click a node → evidence panel →</span>
      </div>
    </div>
  );
}

/* ── layout ─────────────────────────────────────────────── */

function computeLayout(data: GraphView) {
  const byRing = new Map<number, GraphView["nodes"]>();
  const ringOf = new Map<string, number>();
  for (const n of data.nodes) {
    const ring = n.origin ? 0 : clampRing(n.depth + 1);
    ringOf.set(n.key, ring);
    const list = byRing.get(ring) ?? [];
    list.push(n);
    byRing.set(ring, list);
  }

  // parent-based fan-out: nodes on ring k are rotated toward their parents
  const parentAngle = new Map<string, number>();
  const pos = new Map<string, Pt>();
  const placed = new Set<string>();

  // ring 0 (origins) first
  const ring0 = byRing.get(0) ?? [];
  const angles = new Map<string, number>();
  if (ring0.length === 1) {
    const n = ring0[0] as GraphView["nodes"][number];
    pos.set(n.key, { x: 0, y: 0 });
    angles.set(n.key, 0);
    placed.add(n.key);
  } else {
    ring0.forEach((n, i) => {
      const a = (i / Math.max(ring0.length, 1)) * Math.PI * 2;
      pos.set(n.key, { x: Math.cos(a) * RING_R[0], y: Math.sin(a) * RING_R[0] });
      angles.set(n.key, a);
      placed.add(n.key);
    });
  }

  const angleOf = (key: string): number | undefined => angles.get(key);
  for (let k = 1; k <= 5; k++) {
    const nodes = byRing.get(k) ?? [];
    if (nodes.length === 0) continue;
    const firstParentAngle = nodes.map((n) => {
      const pa = data.edges.find((e) => e.dst === n.key && placed.has(e.src) && angleOf(e.src) !== undefined);
      return pa ? (angleOf(pa.src) ?? 0) + 0.18 : n.key.charCodeAt(0) * 0.001;
    });
    // rotate the ring so the node chain follows its parents' angles
    const seed = firstParentAngle[0] as number;
    const rotation = Math.atan2(Math.sin(seed - (Math.PI / 2)), Math.cos(seed - (Math.PI / 2))) + 0.6;
    nodes.forEach((n, i) => {
      const a = rotation + ((i + 0.5) / nodes.length) * Math.PI * 2;
      const r = RING_R[k] as number;
      pos.set(n.key, { x: Math.cos(a) * r, y: Math.sin(a) * r });
      angles.set(n.key, a);
      placed.add(n.key);
    });
  }

  // severity + adjacency for highlight/dim
  const adjacent = new Set<string>();
  for (const e of data.edges) {
    adjacent.add(e.src);
    adjacent.add(e.dst);
  }

  return { nodes: data.nodes, edges: data.edges, pos, ringOf, adjacent };
}

function clampRing(d: number): number {
  return Math.min(Math.max(d, 1), RING_R.length - 1);
}

interface Curved {
  d: string;
}

/** Arc between two points, bowed outward from the graph origin. */
function curveBetween(a: Pt, b: Pt): Curved {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.max(Math.hypot(dx, dy), 1);
  // mid point pushed ~8% outward from center for the circular ripple look
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const mlen = Math.hypot(mx, my);
  const k = mlen > 1 ? 1 + 22 / mlen : 1;
  const cx = mx * k;
  const cy = my * k;
  return { d: `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}` };
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.floor((max - 1) / 2))}…${s.slice(-Math.floor((max - 1) / 2))}`;
}
