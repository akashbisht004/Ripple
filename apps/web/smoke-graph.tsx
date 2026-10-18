/**
 * Throwaway smoke: SSR the ripple graph + report with a real analysis payload
 * so layout/render logic runs without a browser.
 */
import { renderToString } from "react-dom/server";
import { createElement as h } from "react";
import RippleGraph from "./src/components/RippleGraph";
import type { GraphView } from "./src/lib/api-types";

const payload: GraphView = {
  nodes: [
    { key: "src/billing.ts", kind: "File", name: "src/billing.ts", depth: 0, origin: true, severity: null },
    { key: "src/billing.ts::computeDiscount", kind: "Function", name: "computeDiscount", depth: 0, origin: false, severity: "high" },
    { key: "src/checkout.ts::checkout", kind: "Function", name: "checkout", depth: 1, origin: false, severity: "medium" },
    { key: "POST /api/checkout", kind: "ApiRoute", name: "POST /api/checkout", depth: 3, origin: false, severity: "high" },
  ],
  edges: [
    { src: "src/billing.ts", dst: "src/billing.ts::computeDiscount", type: "CONTAINS" },
    { src: "src/checkout.ts::checkout", dst: "src/billing.ts::computeDiscount", type: "CALLS" },
    { src: "POST /api/checkout", dst: "src/app/api/checkout/route.ts::POST", type: "HANDLED_BY" },
  ],
  changed: ["src/billing.ts"],
  truncated: false,
};
const html = renderToString(
  h(RippleGraph, { data: payload, selected: "src/billing.ts::computeDiscount", onSelect: () => {} }),
);

if (!html.includes("graph-node")) throw new Error("no nodes rendered");
if (!html.includes("marker-end")) throw new Error("no edges rendered");
// React splits `hop {i}` text children with comment markers in SSR output
const hopLabels = (html.match(/hop/g) ?? []).length;
if (hopLabels < 4) throw new Error(`hop rings missing (found ${hopLabels})`);
console.log(`✔ RippleGraph SSR ok (${html.length} chars)`);
