/**
 * FalkorDB client singleton + health check.
 *
 * The `falkordb` npm client is a fork of node-redis speaking the FalkorDB
 * module protocol. We expose a single lazily-connected `FalkorDB` instance and
 * a named-graph accessor so every RIPPLE module shares one connection.
 */
import { FalkorDB, type FalkorDBOptions, type Graph } from "falkordb";

export interface GraphConfig {
  host: string;
  port: number;
  graphName: string;
}

const DEFAULTS: GraphConfig = {
  host: process.env.FALKORDB_HOST ?? "localhost",
  port: Number(process.env.FALKORDB_PORT ?? 6379),
  graphName: process.env.FALKORDB_GRAPH ?? "ripple",
};

let clientPromise: Promise<FalkorDB> | null = null;

export function configFromEnv(overrides: Partial<GraphConfig> = {}): GraphConfig {
  const merged: GraphConfig = { ...DEFAULTS };
  // ignore explicit `undefined` overrides (e.g. graphSelector({ graphName: undefined }))
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
  }
  return merged;
}

/** Lazily connect (or reuse) the shared FalkorDB client. */
export function connectGraph(overrides: Partial<GraphConfig> = {}): Promise<FalkorDB> {
  if (!clientPromise) {
    const cfg = configFromEnv(overrides);
    const opts: Partial<FalkorDBOptions> = {
      socket: { host: cfg.host, port: cfg.port },
    };
    clientPromise = FalkorDB.connect(opts as FalkorDBOptions);
  }
  return clientPromise;
}

/** Selector for the active graph; cheap, safe to call repeatedly. */
export async function graphSelector(cfg: Partial<GraphConfig> = {}): Promise<{ graph: Graph; config: GraphConfig }> {
  const config = configFromEnv(cfg);
  const client = (await connectGraph(cfg)) as unknown as { selectGraph(id: string): Graph };
  return { graph: client.selectGraph(config.graphName), config };
}

export async function healthCheckGraph(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const start = Date.now();
  try {
    const { graph } = await graphSelector();
    const ping = await graph.query<{ n: number }>("RETURN 1 AS n");
    const ok = Array.isArray(ping.data);
    return { ok, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function disconnectGraph(): Promise<void> {
  if (!clientPromise) return;
  const client = await clientPromise;
  await client.close();
  clientPromise = null;
}
