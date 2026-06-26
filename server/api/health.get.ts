import { verifyConnectivity } from "~/lib/neo4j";

// Health check for the Neo4j connection. GET /api/health
// This endpoint is unauthenticated, so it intentionally returns only a coarse
// status. Connection details and error messages are logged server-side (by
// verifyConnectivity) but never exposed in the HTTP response.
export default defineEventHandler(async () => {
  const db = await verifyConnectivity();
  return {
    ok: db.ok,
    service: "blueprint",
    db: db.ok ? "up" : "down",
    timestamp: new Date().toISOString(),
  };
});
