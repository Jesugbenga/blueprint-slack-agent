// Diagnostic script for the Neo4j connection. Run with: pnpm db:check
// Loads .env, verifies connectivity, and does a write/read round-trip so you
// can see exactly where (and why) the database is failing.

import "dotenv/config";
import { getDriver, runQuery, verifyConnectivity } from "../server/lib/neo4j";

const DIAG_TOPIC = "__blueprint_diagnostic__";

async function main(): Promise<void> {
  console.log("=== Blueprint Neo4j diagnostic ===");

  // 1. Show which env vars are present (never print secret values).
  const present = (v?: string) => (v ? `set (len ${v.length})` : "MISSING");
  console.log("NEO4J_URI:     ", present(process.env.NEO4J_URI));
  console.log(
    "NEO4J_USER:    ",
    present(process.env.NEO4J_USER || process.env.NEO4J_USERNAME)
  );
  console.log("NEO4J_PASSWORD:", present(process.env.NEO4J_PASSWORD));
  console.log("NEO4J_DATABASE:", present(process.env.NEO4J_DATABASE));

  // 2. Verify the driver can reach the server.
  const conn = await verifyConnectivity();
  console.log("Connectivity:", conn);
  if (!conn.ok) {
    console.error(
      "\n✗ Cannot connect. Common causes: paused Aura instance, wrong URI scheme (use neo4j+s:// for Aura), bad credentials, or network/firewall."
    );
    await getDriver().close();
    process.exit(1);
  }

  // 3. Write/read round-trip on a throwaway node.
  await runQuery(
    "MERGE (t:Topic {name: $name}) SET t.diagnosticAt = datetime() RETURN t.name AS name",
    { name: DIAG_TOPIC },
    "diagnostic-write"
  );
  const counts = await runQuery(
    "MATCH (t:Topic) RETURN count(t) AS topics",
    {},
    "diagnostic-count"
  );
  console.log("Total Topic nodes:", counts[0]?.topics);

  // 4. Clean up the throwaway node.
  await runQuery(
    "MATCH (t:Topic {name: $name}) DETACH DELETE t",
    { name: DIAG_TOPIC },
    "diagnostic-cleanup"
  );

  console.log("\n✓ Database is reachable and read/write works.");
  await getDriver().close();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("Diagnostic failed:", err);
  try {
    await getDriver().close();
  } catch {
    // ignore
  }
  process.exit(1);
});
