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
        // pooled sockets to Aura can go stale. Recycle connections well before
        // Aura's idle cutoff and cap the pool for per-invocation concurrency.
        // Stale-connection recovery is handled by resetDriver() + retry in
        // runQuery, so we keep the acquisition timeout generous here.
        maxConnectionLifetime: 45 * 1000,
        maxConnectionPoolSize: 10,
        connectionAcquisitionTimeout: 20 * 1000,
        connectionTimeout: 15 * 1000,
      },
    );
    console.log(
      `[neo4j] driver created for ${URI} (database: ${DATABASE ?? "default"})`,
    );
  }
  return driver;
}

/**
 * Drop the shared driver so the next getDriver() builds a fresh one. Used to
 * recover from a poisoned pool (e.g. connections leaked when a serverless
 * invocation is killed mid-query). Closing is fire-and-forget because a dead
 * socket's close can itself hang.
 */
function resetDriver(): void {
  const stale = driver;
  driver = null;
  if (stale) {
    void stale.close().catch(() => {
      /* ignore — we're discarding it anyway */
    });
  }
}

/** Errors that indicate the connection pool is stale/exhausted and worth a reset+retry. */
function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /acquisition timed out|ServiceUnavailable|SessionExpired|Pool|connection|ECONNRESET|ETIMEDOUT|socket hang up/i.test(
    msg,
  );
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
 * Run a Cypher query with timing + error logging. On a connection-level error
 * (typical after a serverless freeze leaves the pool stale) it resets the driver
 * and retries once against a fresh connection.
 * @param name Optional label used in logs to identify the query.
 */
export async function runQuery(
  query: string,
  params: Record<string, unknown> = {},
  name = "query",
) {
  try {
    return await runOnce(query, params, name);
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    console.warn(
      `[neo4j] ${name} hit a connection error — resetting driver and retrying once`,
    );
    resetDriver();
    return await runOnce(query, params, name);
  }
}

async function runOnce(
  query: string,
  params: Record<string, unknown>,
  name: string,
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
