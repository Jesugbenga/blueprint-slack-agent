// Backfill Blueprint's memory from existing Slack history.
// Run with: pnpm backfill "<query>" ["<query>" ...]
//
// For each search query it pulls matching messages via the Slack search API
// (real-time search using SLACK_USER_TOKEN), classifies each one, and writes
// decisions / blockers / discussions into the Neo4j memory graph.

import "dotenv/config";
import { classifyMessage } from "../server/lib/classifier";
import {
  getKnownTopics,
  recordDiscussion,
  storeBlocker,
  storeDecision,
} from "../server/lib/graph";
import { getDriver } from "../server/lib/neo4j";
import { searchSlack } from "../server/lib/slack/search";

async function main(): Promise<void> {
  const queries = process.argv.slice(2).filter(Boolean);
  if (queries.length === 0) {
    console.error('Usage: pnpm backfill "<query>" ["<query>" ...]');
    process.exitCode = 1;
    return;
  }

  const userToken = process.env.SLACK_USER_TOKEN;
  if (!userToken) {
    console.error(
      "✗ SLACK_USER_TOKEN is not set. Add a user token (xoxp-) with the search:read scope to .env.",
    );
    process.exitCode = 1;
    return;
  }

  let stored = 0;
  let skipped = 0;

  for (const query of queries) {
    console.log(`\n🔎 Searching: "${query}"`);
    const messages = await searchSlack(query, userToken, 50);
    console.log(`   ${messages.length} message(s) found`);

    for (const m of messages) {
      if (!m.text || !m.userId) {
        skipped++;
        continue;
      }

      const knownTopics = await getKnownTopics().catch(() => [] as string[]);
      const result = await classifyMessage(m.text, knownTopics);

      if (result.type === "none" || !result.topic || !result.summary) {
        skipped++;
        continue;
      }

      const personName = m.username || m.userId;
      const channel = m.channelId ?? "";
      const threadTs = m.ts ?? "";

      await recordDiscussion(m.userId, personName, result.topic);

      if (result.type === "decision") {
        await storeDecision({
          personId: m.userId,
          personName,
          topic: result.topic,
          summary: result.summary,
          channel,
          threadTs,
        });
        stored++;
        console.log(`   ✓ decision [${result.topic}] ${result.summary}`);
      } else if (result.type === "blocker") {
        await storeBlocker({
          personId: m.userId,
          personName,
          topic: result.topic,
          summary: result.summary,
          channel,
          threadTs,
        });
        stored++;
        console.log(`   ✓ blocker  [${result.topic}] ${result.summary}`);
      } else {
        // question — recorded as a discussion only
        stored++;
        console.log(`   · question [${result.topic}] (discussion recorded)`);
      }
    }
  }

  console.log(`\n=== Backfill complete: ${stored} stored, ${skipped} skipped ===`);
}

main()
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getDriver().close();
  });
