import neo4j, { type Driver, type ServerInfo } from "neo4j-driver";

const URI = process.env.NEO4J_URI;
// Support both NEO4J_USER and Aura's NEO4J_USERNAME naming.
const USER = process.env.NEO4J_USER || process.env.NEO4J_USERNAME;
const PASSWORD = process.env.NEO4J_PASSWORD;
const DATABASE = process.env.NEO4J_DATABASE;

/** Throws a clear error listing any missing Neo4j environment variables. */
function assertConfig() {
  const missing: string[] = [];
  if (!URI) missing.push("NEO4J_URI");
  if (!USER) missing.push("NEO4J_USER (or NEO4J_USERNAME)");
  if (!PASSWORD) missing.push("NEO4J_PASSWORD");
  if (missing.length > 0) {
    throw new Error(
      `[neo4j] Missing required environment variable(s): ${missing.join(
        ", ",
      )}. Add them to your .env file.`,
    );
  }
}

let driver: Driver | null = null;

/** Lazily create the shared driver so a missing config logs clearly instead of crashing at import. */
export function getDriver(): Driver {
  if (!driver) {
    assertConfig();
    driver = neo4j.driver(
      URI as string,
      neo4j.auth.basic(USER as string, PASSWORD as string),
      {
        // Return Neo4j integers as native JS numbers so counts/dates are easy to use.
        disableLosslessIntegers: true,
        // Serverless tuning: Vercel freezes the function between invocations, so
        // pooled TCP sockets to Aura go stale. Always liveness-check a pooled
        // connection before reuse (0 = check every time), recycle connections
        // aggressively, and fail fast instead of hanging for the 60s default.
        connectionLivenessCheckTimeout: 0,
        maxConnectionLifetime: 60 * 1000,
        maxConnectionPoolSize: 5,
        connectionAcquisitionTimeout: 10 * 1000,
        connectionTimeout: 15 * 1000,
      },
    );
    console.log(
      `[neo4j] driver created for ${URI} (database: ${DATABASE ?? "default"})`,
    );
  }
  return driver;
}

export interface ConnectivityResult {
  ok: boolean;
  uri?: string;
  database?: string;
  address?: string;
  version?: string;
  error?: string;
}

/** Verify the driver can actually reach the database. Use for health checks. */
export async function verifyConnectivity(): Promise<ConnectivityResult> {
  try {
    assertConfig();
    const info: ServerInfo = await getDriver().getServerInfo({
      database: DATABASE,
    });
    console.log(
      `[neo4j] connectivity OK — ${info.address} (protocol ${info.protocolVersion})`,
    );
    return {
      ok: true,
      uri: URI,
      database: DATABASE ?? "default",
      address: info.address,
      version: String(info.protocolVersion),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[neo4j] connectivity FAILED: ${message}`);
    return {
      ok: false,
      uri: URI,
      database: DATABASE ?? "default",
      error: message,
    };
  }
}

/**
 * Run a Cypher query with timing + error logging.
 * @param name Optional label used in logs to identify the query.
 */
export async function runQuery(
  query: string,
  params: Record<string, unknown> = {},
  name = "query",
) {
  const start = Date.now();
  const session = getDriver().session(
    DATABASE ? { database: DATABASE } : undefined,
  );
  try {
    const result = await session.run(query, params);
    const ms = Date.now() - start;
    console.log(
      `[neo4j] ${name} OK — ${result.records.length} row(s) in ${ms}ms`,
    );
    return result.records.map((r) => r.toObject());
  } catch (err) {
    const ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[neo4j] ${name} FAILED after ${ms}ms: ${message}`);
    throw err;
  } finally {
    await session.close();
  }
}

export default getDriver;
