/**
 * Batched graph writer.
 *
 * Accumulates node/edge upsert operations and flushes them to FalkorDB with
 * UNWIND + MERGE so re-running ingestion updates the graph in place instead
 * of duplicating it (keyed upsert semantics, per docs/implementation.md §5).
 */
import type { Graph } from "falkordb";
import { INDEX_PLAN, NODE_KEY_FIELD } from "./schema.js";

export type PropValue = string | number | boolean | null | PropValue[] | { [key: string]: PropValue };
export type Props = { [key: string]: PropValue };

export interface NodeOp {
  label: string;
  props: Props;
}

export interface EdgeOp {
  type: string;
  fromKey: string;
  toKey: string;
  props?: Props;
}

interface Batches {
  nodes: Map<string, NodeOp[]>; // one queue per label
  edges: Map<string, EdgeOp[]>; // one queue per edge type
}

const BATCH_SIZE = 250;

export class GraphWriter {
  private batches: Batches = { nodes: new Map(), edges: new Map() };
  private stats = { nodes: 0, edges: 0, batches: 0 };

  constructor(private readonly graph: Graph) {}

  /** Queue a node upsert; `props[NODE_KEY_FIELD]` must exist. */
  addNode(label: string, props: Props): void {
    if (props[NODE_KEY_FIELD] === undefined) {
      throw new Error(`Node of label ${label} is missing '${NODE_KEY_FIELD}'`);
    }
    const key = label;
    const queue = this.batches.nodes.get(key) ?? [];
    queue.push({ label, props });
    this.batches.nodes.set(key, queue);
  }

  /** Queue a relationship upsert between two node keys. */
  addEdge(type: string, fromKey: string, toKey: string, props: Props = {}): void {
    const queue = this.batches.edges.get(type) ?? [];
    queue.push({ type, fromKey, toKey, props });
    this.batches.edges.set(type, queue);
  }

  get pending(): number {
    let count = 0;
    for (const q of this.batches.nodes.values()) count += q.length;
    for (const q of this.batches.edges.values()) count += q.length;
    return count;
  }

  get report(): typeof this.stats {
    return { ...this.stats };
  }

  /** Create range + fulltext indexes for known labels/props (idempotent). */
  async ensureIndexes(): Promise<void> {
    for (const { label, props } of INDEX_PLAN) {
      for (const prop of props) {
        // FalkorDB errors if an identical index already exists; ignore that.
        try {
          await this.graph.createNodeRangeIndex(label, prop);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/already (exist|indexed)/i.test(msg)) throw new Error(`Index ${label}.${prop}: ${msg}`);
        }
      }
    }
    // fulltext index backing the agent's search_code_semantic tool
    try {
      await this.graph.createNodeFulltextIndex(
        "Function","qualifiedName","name",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already (exist|indexed)/i.test(msg)) throw new Error(`Fulltext Function index: ${msg}`);
    }
    try {
      await this.graph.createNodeFulltextIndex(
        "File","path",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already (exist|indexed)/i.test(msg)) throw new Error(`Fulltext File index: ${msg}`);
    }
  }

  /** Flush all queued ops to FalkorDB in batches. */
  async flush(): Promise<void> {
    for (const [label, queue] of this.batches.nodes) {
      for (let i = 0; i < queue.length; i += BATCH_SIZE) {
        const chunk = queue.slice(i, i + BATCH_SIZE);
        const props = chunk.map((op) => op.props);
        await this.graph.query(
          `UNWIND $rows AS row
           MERGE (n:${label} { ${NODE_KEY_FIELD}: row.${NODE_KEY_FIELD} })
           SET n += row`,
          { params: { rows: props } },
        );
        this.stats.nodes += chunk.length;
        this.stats.batches += 1;
      }
      this.batches.nodes.delete(label);
    }

    for (const [type, queue] of this.batches.edges) {
      for (let i = 0; i < queue.length; i += BATCH_SIZE) {
        const chunk = queue.slice(i, i + BATCH_SIZE);
        const rows = chunk.map((op) => ({
          from: op.fromKey,
          to: op.toKey,
          props: op.props ?? {},
        }));
        await this.graph.query(
          `UNWIND $rows AS row
           MATCH (a { ${NODE_KEY_FIELD}: row.from })
           MATCH (b { ${NODE_KEY_FIELD}: row.to })
           MERGE (a)-[r:${type}]->(b)
           SET r += row.props`,
          { params: { rows } },
        );
        this.stats.edges += chunk.length;
        this.stats.batches += 1;
      }
      this.batches.edges.delete(type);
    }
  }
}
