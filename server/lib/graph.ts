import neo4j from "neo4j-driver";
import { runQuery } from "./neo4j";

/** Normalize a free-text topic into a stable snake_case key. */
export function normalizeTopic(topic: string): string {
  return topic
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function storeDecision({
  personId,
  personName,
  topic,
  summary,
  channel,
  threadTs,
  teamId,
}: {
  personId: string;
  personName: string;
  topic: string;
  summary: string;
  channel: string;
  threadTs: string;
  teamId: string;
}) {
  topic = normalizeTopic(topic);
  await runQuery(
    `
    MERGE (p:Person {slackId: $personId, teamId: $teamId})
    SET p.name = $personName
    MERGE (t:Topic {name: $topic, teamId: $teamId})
    CREATE (d:Decision {
      summary: $summary,
      channel: $channel,
      threadTs: $threadTs,
      teamId: $teamId,
      date: datetime()
    })
    MERGE (p)-[:MADE]->(d)
    MERGE (d)-[:ABOUT]->(t)
  `,
    { personId, personName, topic, summary, channel, threadTs, teamId },
  );
}

export async function storeBlocker({
  personId,
  personName,
  topic,
  summary,
  channel,
  threadTs,
  teamId,
}: {
  personId: string;
  personName: string;
  topic: string;
  summary: string;
  channel: string;
  threadTs: string;
  teamId: string;
}) {
  topic = normalizeTopic(topic);
  await runQuery(
    `
    MERGE (p:Person {slackId: $personId, teamId: $teamId})
    SET p.name = $personName
    MERGE (t:Topic {name: $topic, teamId: $teamId})
    CREATE (m:Message {
      text: $summary,
      ts: $threadTs,
      channel: $channel,
      type: "blocker",
      teamId: $teamId,
      date: datetime()
    })
    MERGE (p)-[:SENT]->(m)
    MERGE (m)-[:RAISED_CONCERN_ABOUT]->(t)
  `,
    { personId, personName, topic, summary, channel, threadTs, teamId },
  );
}

export async function recordDiscussion(
  personId: string,
  personName: string,
  topic: string,
  teamId: string,
) {
  topic = normalizeTopic(topic);
  await runQuery(
    `
    MERGE (p:Person {slackId: $personId, teamId: $teamId})
    SET p.name = $personName
    MERGE (t:Topic {name: $topic, teamId: $teamId})
    MERGE (p)-[r:DISCUSSED]->(t)
    ON CREATE SET r.count = 1
    ON MATCH SET r.count = r.count + 1
  `,
    { personId, personName, topic, teamId },
  );
}

// ---------------------------------------------------------------------------
// Read layer — lets the agent and slash commands consult the living memory.
// ---------------------------------------------------------------------------

export interface DecisionRecord {
  summary: string;
  personId: string;
  personName: string;
  channel: string;
  threadTs: string;
  date: string;
}

export interface BlockerRecord {
  summary: string;
  personId: string;
  personName: string;
  channel: string;
  threadTs: string;
  date: string;
}

export interface ExpertRecord {
  personId: string;
  personName: string;
  count: number;
}

/** Decisions recorded about a topic, most recent first. */
export async function queryDecisions(
  topic: string,
  teamId: string,
  limit = 10,
): Promise<DecisionRecord[]> {
  const records = await runQuery(
    `
    MATCH (p:Person)-[:MADE]->(d:Decision)-[:ABOUT]->(t:Topic {name: $topic, teamId: $teamId})
    RETURN d.summary AS summary,
           p.slackId AS personId,
           p.name AS personName,
           d.channel AS channel,
           d.threadTs AS threadTs,
           toString(d.date) AS date
    ORDER BY d.date DESC
    LIMIT $limit
  `,
    { topic: normalizeTopic(topic), teamId, limit: neo4j.int(limit) },
  );
  return records as DecisionRecord[];
}

/** Blockers / concerns raised about a topic, most recent first. */
export async function queryBlockers(
  topic: string,
  teamId: string,
  limit = 10,
): Promise<BlockerRecord[]> {
  const records = await runQuery(
    `
    MATCH (p:Person)-[:SENT]->(m:Message {type: "blocker"})-[:RAISED_CONCERN_ABOUT]->(t:Topic {name: $topic, teamId: $teamId})
    RETURN m.text AS summary,
           p.slackId AS personId,
           p.name AS personName,
           m.channel AS channel,
           m.ts AS threadTs,
           toString(m.date) AS date
    ORDER BY m.date DESC
    LIMIT $limit
  `,
    { topic: normalizeTopic(topic), teamId, limit: neo4j.int(limit) },
  );
  return records as BlockerRecord[];
}

/** People who have discussed a topic, ranked by how often. */
export async function whoKnows(
  topic: string,
  teamId: string,
  limit = 10,
): Promise<ExpertRecord[]> {
  const records = await runQuery(
    `
    MATCH (p:Person)-[r:DISCUSSED]->(t:Topic {name: $topic, teamId: $teamId})
    RETURN p.slackId AS personId,
           p.name AS personName,
           r.count AS count
    ORDER BY r.count DESC
    LIMIT $limit
  `,
    { topic: normalizeTopic(topic), teamId, limit: neo4j.int(limit) },
  );
  return records as ExpertRecord[];
}

/** All known topics, used to keep classification labels consistent. */
export async function getKnownTopics(teamId: string, limit = 200): Promise<string[]> {
  const records = await runQuery(
    `
    MATCH (t:Topic {teamId: $teamId})
    RETURN t.name AS name
    ORDER BY t.name
    LIMIT $limit
  `,
    { teamId, limit: neo4j.int(limit) },
  );
  return records.map((r) => r.name as string);
}

// ---------------------------------------------------------------------------
// Design layer — collaborative Block Kit UI designs, their current spec, and an
// append-only edit history, all tenant-scoped by teamId.
// ---------------------------------------------------------------------------

export interface DesignRecord {
  title: string;
  topic: string;
  description: string;
  status: "draft" | "approved";
  /** JSON-encoded UISpec (array of components). */
  spec: string;
  /** JSON-encoded DesignEnrichment snapshot. */
  enrichment: string;
}

/** Create or replace a design's current state. */
export async function saveDesign(opts: {
  designId: string;
  teamId: string;
  channel: string;
  threadTs: string;
  title: string;
  topic: string;
  description: string;
  status: "draft" | "approved";
  spec: string;
  enrichment: string;
  authorId: string;
  authorName: string;
}) {
  await runQuery(
    `
    MERGE (d:Design {designId: $designId, teamId: $teamId})
    ON CREATE SET d.createdAt = datetime()
    SET d.channel = $channel,
        d.threadTs = $threadTs,
        d.title = $title,
        d.topic = $topic,
        d.description = $description,
        d.status = $status,
        d.spec = $spec,
        d.enrichment = $enrichment,
        d.updatedAt = datetime()
    MERGE (p:Person {slackId: $authorId, teamId: $teamId})
    SET p.name = $authorName
    MERGE (p)-[:CREATED]->(d)
  `,
    opts,
  );
}

/** Update just the spec/status of an existing design. */
export async function updateDesignSpec(opts: {
  designId: string;
  teamId: string;
  spec: string;
  status: "draft" | "approved";
}) {
  await runQuery(
    `
    MATCH (d:Design {designId: $designId, teamId: $teamId})
    SET d.spec = $spec, d.status = $status, d.updatedAt = datetime()
  `,
    opts,
  );
}

/** Load a design's current state, or null if it doesn't exist. */
export async function getDesign(
  designId: string,
  teamId: string,
): Promise<DesignRecord | null> {
  const records = await runQuery(
    `
    MATCH (d:Design {designId: $designId, teamId: $teamId})
    RETURN d.title AS title,
           d.topic AS topic,
           d.description AS description,
           d.status AS status,
           d.spec AS spec,
           d.enrichment AS enrichment
  `,
    { designId, teamId },
  );
  return (records[0] as DesignRecord | undefined) ?? null;
}

/** Append an entry to a design's edit history (who changed what, when). */
export async function recordDesignEdit(opts: {
  designId: string;
  teamId: string;
  action: string;
  detail: string;
  byId: string;
  byName: string;
}) {
  await runQuery(
    `
    MATCH (d:Design {designId: $designId, teamId: $teamId})
    MERGE (p:Person {slackId: $byId, teamId: $teamId})
    SET p.name = $byName
    CREATE (e:DesignEdit {
      action: $action,
      detail: $detail,
      teamId: $teamId,
      at: datetime()
    })
    MERGE (p)-[:MADE_EDIT]->(e)
    MERGE (e)-[:ON_DESIGN]->(d)
  `,
    opts,
  );
}
