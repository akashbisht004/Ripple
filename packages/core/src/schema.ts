/**
 * Graph schema constants for the RIPPLE property graph, mirroring
 * docs/implementation.md §2, plus index creation helpers.
 */
export const NODE_LABELS = {
  FILE: "File",
  FUNCTION: "Function",
  CLASS: "Class",
  TYPE: "Type",
  API_ROUTE: "ApiRoute",
  TEST: "Test",
  COMMIT: "Commit",
  BUG: "Bug",
  ISSUE: "Issue",
  ANALYSIS: "Analysis",
} as const;

export const EDGE_TYPES = {
  CONTAINS: "CONTAINS",
  DEPENDS_ON: "DEPENDS_ON",
  CALLS: "CALLS",
  USES_TYPE: "USES_TYPE",
  HANDLED_BY: "HANDLED_BY",
  TESTED_BY: "TESTED_BY",
  TOUCHED: "TOUCHED",
  FIXED: "FIXED",
  REFERS_TO: "REFERS_TO",
  FLAGGED: "FLAGGED",
} as const;

/**
 * Every stored node carries a stable `key` we MERGE on:
 *  - File: repo-relative POSIX path
 *  - Function/Class/Type: `file::name` for local decls, `name` for externals
 *  - Test: `file::name`
 *  - Commit: sha
 *  - Bug/Issue: `kind#number`
 */
export const NODE_KEY_FIELD = "key";

/** (label, properties) pairs to be indexed for fast lookups. */
export const INDEX_PLAN: Array<{ label: string; props: string[] }> = [
  { label: NODE_LABELS.FILE, props: ["path"] },
  { label: NODE_LABELS.FUNCTION, props: ["name", "qualifiedName"] },
  { label: NODE_LABELS.CLASS, props: ["name", "qualifiedName"] },
  { label: NODE_LABELS.TYPE, props: ["name"] },
  { label: NODE_LABELS.API_ROUTE, props: ["path"] },
  { label: NODE_LABELS.TEST, props: ["name"] },
  { label: NODE_LABELS.COMMIT, props: ["sha"] },
  { label: NODE_LABELS.BUG, props: ["title"] },
];
