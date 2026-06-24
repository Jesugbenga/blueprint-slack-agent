import { runQuery } from "./neo4j";

export async function storeDecision({
  personId,
  personName,
  topic,
  summary,
  channel,
  threadTs,
}: {
  personId: string;
  personName: string;
  topic: string;
  summary: string;
  channel: string;
  threadTs: string;
}) {
  await runQuery(
    `
    MERGE (p:Person {slackId: $personId})
    SET p.name = $personName
    MERGE (t:Topic {name: $topic})
    CREATE (d:Decision {
      summary: $summary,
      channel: $channel,
      threadTs: $threadTs,
      date: datetime()
    })
    MERGE (p)-[:MADE]->(d)
    MERGE (d)-[:ABOUT]->(t)
  `,
    { personId, personName, topic, summary, channel, threadTs }
  );
}

export async function storeBlocker({
  personId,
  personName,
  topic,
  summary,
  channel,
  threadTs,
}: {
  personId: string;
  personName: string;
  topic: string;
  summary: string;
  channel: string;
  threadTs: string;
}) {
  await runQuery(
    `
    MERGE (p:Person {slackId: $personId})
    SET p.name = $personName
    MERGE (t:Topic {name: $topic})
    CREATE (m:Message {
      text: $summary,
      ts: $threadTs,
      channel: $channel,
      type: "blocker",
      date: datetime()
    })
    MERGE (p)-[:SENT]->(m)
    MERGE (m)-[:RAISED_CONCERN_ABOUT]->(t)
  `,
    { personId, personName, topic, summary, channel, threadTs }
  );
}

export async function recordDiscussion(
  personId: string,
  personName: string,
  topic: string
) {
  await runQuery(
    `
    MERGE (p:Person {slackId: $personId})
    SET p.name = $personName
    MERGE (t:Topic {name: $topic})
    MERGE (p)-[r:DISCUSSED]->(t)
    ON CREATE SET r.count = 1
    ON MATCH SET r.count = r.count + 1
  `,
    { personId, personName, topic }
  );
}