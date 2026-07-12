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
export async function getKnownTopics(
  teamId: string,
  limit = 200,
): Promise<string[]> {
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
// Feature 1 — Timezone Handoff Agent + Async Relay
// ---------------------------------------------------------------------------

export interface PersonTimezone {
  /** IANA timezone id, e.g. "Europe/London". */
  timezone: string;
  /** Offset from UTC in seconds (as Slack reports tz_offset). */
  tzOffset: number;
  /** Minutes-from-local-midnight the workday ends (default 1050 = 17:30). */
  workdayEnd: number;
}

/** Cache a person's timezone on their node so we don't call users.info repeatedly. */
export async function cachePersonTimezone(opts: {
  personId: string;
  personName: string;
  teamId: string;
  timezone: string;
  tzOffset: number;
  workdayEnd?: number;
}) {
  await runQuery(
    `
    MERGE (p:Person {slackId: $personId, teamId: $teamId})
    SET p.name = $personName,
        p.timezone = $timezone,
        p.tzOffset = $tzOffset,
        p.workdayEnd = coalesce($workdayEnd, p.workdayEnd, 1050),
        p.timezoneCachedAt = datetime()
  `,
    { workdayEnd: null, ...opts },
    "cachePersonTimezone",
  );
}

/**
 * Atomically claim the once-per-user end-of-day handoff schedule. Returns true
 * only the first time it's called for a person, so the caller starts exactly one
 * durable handoff workflow per user.
 */
export async function tryClaimHandoffSchedule(
  personId: string,
  personName: string,
  teamId: string,
): Promise<boolean> {
  const records = await runQuery(
    `
    MERGE (p:Person {slackId: $personId, teamId: $teamId})
    SET p.name = $personName
    WITH p, coalesce(p.handoffScheduled, false) AS was
    SET p.handoffScheduled = true
    RETURN was AS was
  `,
    { personId, personName, teamId },
    "tryClaimHandoffSchedule",
  );
  return records[0]?.was === false;
}

/** Read a person's cached timezone, or null if we've never fetched it. */
export async function getPersonTimezone(
  personId: string,
  teamId: string,
): Promise<PersonTimezone | null> {
  const records = await runQuery(
    `
    MATCH (p:Person {slackId: $personId, teamId: $teamId})
    WHERE p.timezone IS NOT NULL
    RETURN p.timezone AS timezone,
           p.tzOffset AS tzOffset,
           coalesce(p.workdayEnd, 1050) AS workdayEnd
  `,
    { personId, teamId },
    "getPersonTimezone",
  );
  return (records[0] as PersonTimezone | undefined) ?? null;
}

export interface OpenItem {
  kind: "blocker" | "question" | "decision";
  id: string;
  summary: string;
  channel: string;
  threadTs: string;
}

/**
 * Every unresolved thing a person is on the hook for: blockers they raised that
 * aren't resolved, questions they asked that nobody answered, and decisions they
 * made that still have a pending follow-up flag.
 */
export async function getOpenItemsForPerson(
  personId: string,
  teamId: string,
): Promise<OpenItem[]> {
  const records = await runQuery(
    `
    MATCH (p:Person {slackId: $personId, teamId: $teamId})-[:SENT]->(m:Message {type: "blocker"})
    WHERE coalesce(m.resolved, false) = false
    RETURN "blocker" AS kind, elementId(m) AS id, m.text AS summary,
           m.channel AS channel, m.ts AS threadTs, m.date AS date
    UNION
    MATCH (p:Person {slackId: $personId, teamId: $teamId})-[:ASKED]->(q:Question)
    WHERE coalesce(q.answered, false) = false
    RETURN "question" AS kind, elementId(q) AS id, q.text AS summary,
           q.channel AS channel, q.ts AS threadTs, q.ts AS date
    UNION
    MATCH (p:Person {slackId: $personId, teamId: $teamId})-[:MADE]->(d:Decision)
    WHERE coalesce(d.pendingFollowUp, false) = true
      AND coalesce(d.superseded, false) = false
    RETURN "decision" AS kind, elementId(d) AS id, d.summary AS summary,
           d.channel AS channel, d.threadTs AS threadTs, d.date AS date
  `,
    { personId, teamId },
    "getOpenItemsForPerson",
  );
  return records.map((r) => ({
    kind: r.kind as OpenItem["kind"],
    id: r.id as string,
    summary: r.summary as string,
    channel: (r.channel as string) ?? "",
    threadTs: (r.threadTs as string) ?? "",
  }));
}

/** The channels a person posted in most on a given UTC day, busiest first. */
export async function getMostActiveChannels(
  personId: string,
  teamId: string,
  sinceIso: string,
  limit = 3,
): Promise<string[]> {
  const records = await runQuery(
    `
    MATCH (p:Person {slackId: $personId, teamId: $teamId})-[:SENT]->(m:Message)
    WHERE m.date >= datetime($sinceIso) AND m.channel IS NOT NULL
    RETURN m.channel AS channel, count(*) AS c
    ORDER BY c DESC
    LIMIT $limit
  `,
    { personId, teamId, sinceIso, limit: neo4j.int(limit) },
    "getMostActiveChannels",
  );
  return records.map((r) => r.channel as string);
}

export interface CoverCandidate {
  personId: string;
  personName: string;
  timezone: string;
  tzOffset: number;
  workdayEnd: number;
}

/**
 * People who could cover for someone, ranked by total topic activity. Only
 * returns people whose timezone we've cached (so we can check if they're online).
 */
export async function getCoverCandidates(
  teamId: string,
  excludePersonId: string,
  limit = 20,
): Promise<CoverCandidate[]> {
  const records = await runQuery(
    `
    MATCH (p:Person {teamId: $teamId})-[r:DISCUSSED]->(:Topic)
    WHERE p.slackId <> $excludePersonId AND p.timezone IS NOT NULL
    RETURN p.slackId AS personId,
           p.name AS personName,
           p.timezone AS timezone,
           p.tzOffset AS tzOffset,
           coalesce(p.workdayEnd, 1050) AS workdayEnd,
           sum(r.count) AS activity
    ORDER BY activity DESC
    LIMIT $limit
  `,
    { teamId, excludePersonId, limit: neo4j.int(limit) },
    "getCoverCandidates",
  );
  return records.map((r) => ({
    personId: r.personId as string,
    personName: r.personName as string,
    timezone: r.timezone as string,
    tzOffset: r.tzOffset as number,
    workdayEnd: r.workdayEnd as number,
  }));
}

/** Record a question in the graph so the relay can track/answer it later. */
export async function storeQuestion(opts: {
  questionId: string;
  personId: string;
  personName: string;
  text: string;
  channel: string;
  threadTs: string;
  teamId: string;
}) {
  await runQuery(
    `
    MERGE (p:Person {slackId: $personId, teamId: $teamId})
    SET p.name = $personName
    MERGE (q:Question {questionId: $questionId, teamId: $teamId})
    ON CREATE SET q.text = $text,
                  q.channel = $channel,
                  q.ts = $threadTs,
                  q.answered = false,
                  q.confidence = 0.0,
                  q.createdAt = datetime()
    MERGE (p)-[:ASKED]->(q)
  `,
    opts,
    "storeQuestion",
  );
}

/** Flag a question as answered and record the confidence Blueprint had. */
export async function markQuestionAnswered(
  questionId: string,
  teamId: string,
  confidence: number,
) {
  await runQuery(
    `
    MATCH (q:Question {questionId: $questionId, teamId: $teamId})
    SET q.answered = true, q.confidence = $confidence, q.answeredAt = datetime()
  `,
    { questionId, teamId, confidence },
    "markQuestionAnswered",
  );
}

/** Resolve an open handoff item (blocker or question) once someone picks it up. */
export async function resolveOpenItem(
  kind: "blocker" | "question" | "decision",
  id: string,
  teamId: string,
) {
  const label =
    kind === "question"
      ? "Question"
      : kind === "decision"
        ? "Decision"
        : "Message";
  const prop =
    kind === "question"
      ? "answered"
      : kind === "decision"
        ? "pendingFollowUp"
        : "resolved";
  const value = kind === "decision" ? "false" : "true";
  await runQuery(
    `
    MATCH (n:${label} {teamId: $teamId}) WHERE elementId(n) = $id
    SET n.${prop} = ${value}, n.resolvedAt = datetime()
  `,
    { id, teamId },
    "resolveOpenItem",
  );
}

/** Record that a question was relayed to a person, with when and how confident. */
export async function recordRelay(opts: {
  questionId: string;
  toPersonId: string;
  toPersonName: string;
  teamId: string;
  confidence: number;
}) {
  await runQuery(
    `
    MATCH (q:Question {questionId: $questionId, teamId: $teamId})
    MERGE (p:Person {slackId: $toPersonId, teamId: $teamId})
    SET p.name = $toPersonName
    MERGE (q)-[r:RELAYED_TO]->(p)
    SET r.at = datetime(), r.confidence = $confidence
    SET q.confidence = $confidence
  `,
    opts,
    "recordRelay",
  );
}

// ---------------------------------------------------------------------------
// Feature 2 — Decision Drift Detector
// ---------------------------------------------------------------------------

export interface TopicDecisionRecord extends DecisionRecord {
  /** Stable node id used to build SUPERSEDES relationships. */
  id: string;
  topic: string;
}

/**
 * Decisions whose topic overlaps any of the given keywords. Used by drift
 * detection to find prior decisions that a new proposal might contradict.
 */
export async function getDecisionsAboutTopic(
  topicKeywords: string[],
  teamId: string,
  limit = 20,
): Promise<TopicDecisionRecord[]> {
  const keys = topicKeywords.map(normalizeTopic).filter(Boolean);
  if (keys.length === 0) return [];
  const records = await runQuery(
    `
    MATCH (p:Person)-[:MADE]->(d:Decision)-[:ABOUT]->(t:Topic {teamId: $teamId})
    WHERE coalesce(d.superseded, false) = false
      AND any(k IN $keys WHERE t.name CONTAINS k OR k CONTAINS t.name)
    RETURN elementId(d) AS id,
           d.summary AS summary,
           t.name AS topic,
           p.slackId AS personId,
           p.name AS personName,
           d.channel AS channel,
           d.threadTs AS threadTs,
           toString(d.date) AS date
    ORDER BY d.date DESC
    LIMIT $limit
  `,
    { keys, teamId, limit: neo4j.int(limit) },
    "getDecisionsAboutTopic",
  );
  return records as TopicDecisionRecord[];
}

/**
 * Store a decision node and return its stable id (used when the drift flow needs
 * to link a new decision as SUPERSEDES an old one).
 */
export async function createDecision(opts: {
  personId: string;
  personName: string;
  topic: string;
  summary: string;
  channel: string;
  threadTs: string;
  teamId: string;
}): Promise<string> {
  const topic = normalizeTopic(opts.topic);
  const records = await runQuery(
    `
    MERGE (p:Person {slackId: $personId, teamId: $teamId})
    SET p.name = $personName
    MERGE (t:Topic {name: $topic, teamId: $teamId})
    CREATE (d:Decision {
      summary: $summary,
      channel: $channel,
      threadTs: $threadTs,
      teamId: $teamId,
      superseded: false,
      driftFalsePositive: false,
      date: datetime()
    })
    MERGE (p)-[:MADE]->(d)
    MERGE (d)-[:ABOUT]->(t)
    RETURN elementId(d) AS id
  `,
    { ...opts, topic },
    "createDecision",
  );
  return records[0]?.id as string;
}

/** Mark oldDecision as superseded by newDecision. */
export async function supersede(
  newDecisionId: string,
  oldDecisionId: string,
  teamId: string,
) {
  await runQuery(
    `
    MATCH (nw:Decision {teamId: $teamId}) WHERE elementId(nw) = $newDecisionId
    MATCH (old:Decision {teamId: $teamId}) WHERE elementId(old) = $oldDecisionId
    MERGE (nw)-[:SUPERSEDES]->(old)
    SET old.superseded = true
  `,
    { newDecisionId, oldDecisionId, teamId },
    "supersede",
  );
}

/** Log a false positive so the detector can be tuned over time. */
export async function flagDriftFalsePositive(
  decisionId: string,
  teamId: string,
) {
  await runQuery(
    `
    MATCH (d:Decision {teamId: $teamId}) WHERE elementId(d) = $decisionId
    SET d.driftFalsePositive = true
  `,
    { decisionId, teamId },
    "flagDriftFalsePositive",
  );
}

// ---------------------------------------------------------------------------
// Feature 3 — Context Gap Detector
// ---------------------------------------------------------------------------

/**
 * Persist a fully-enriched feature spec and wire it to its topic, owner, and any
 * decisions that informed it.
 */
export async function storeFeature(opts: {
  featureId: string;
  teamId: string;
  title: string;
  description: string;
  owner: string;
  scope: string;
  deadline: string;
  acceptanceCriteria: string;
  topic: string;
  ownerId?: string;
  ownerName?: string;
  informedByDecisionIds?: string[];
}) {
  const topic = normalizeTopic(opts.topic);
  await runQuery(
    `
    MERGE (f:Feature {featureId: $featureId, teamId: $teamId})
    ON CREATE SET f.createdAt = datetime()
    SET f.title = $title,
        f.description = $description,
        f.owner = $owner,
        f.scope = $scope,
        f.deadline = $deadline,
        f.acceptanceCriteria = $acceptanceCriteria,
        f.updatedAt = datetime()
    MERGE (t:Topic {name: $topic, teamId: $teamId})
    MERGE (f)-[:ABOUT]->(t)
    WITH f
    FOREACH (_ IN CASE WHEN $ownerId IS NULL THEN [] ELSE [1] END |
      MERGE (o:Person {slackId: $ownerId, teamId: $teamId})
      SET o.name = coalesce($ownerName, o.name)
      MERGE (o)-[:OWNS]->(f)
    )
  `,
    {
      ...opts,
      topic,
      ownerId: opts.ownerId ?? null,
      ownerName: opts.ownerName ?? null,
      informedByDecisionIds: opts.informedByDecisionIds ?? [],
    },
    "storeFeature",
  );
  // Link decisions in a second pass (MERGE-on-elementId can't run inside FOREACH).
  if (opts.informedByDecisionIds && opts.informedByDecisionIds.length > 0) {
    await runQuery(
      `
      MATCH (f:Feature {featureId: $featureId, teamId: $teamId})
      MATCH (d:Decision {teamId: $teamId}) WHERE elementId(d) IN $ids
      MERGE (f)-[:INFORMED_BY]->(d)
    `,
      {
        featureId: opts.featureId,
        teamId: opts.teamId,
        ids: opts.informedByDecisionIds,
      },
      "linkFeatureDecisions",
    );
  }
}

/**
 * Transient store for a gap analysis while the user fills in the modal. Button
 * values and modal metadata are size-limited, so the full analysis lives here
 * keyed by a short draftId that the button/modal carry instead.
 */
export async function saveGapDraft(opts: {
  draftId: string;
  teamId: string;
  payload: string;
}) {
  await runQuery(
    `
    MERGE (fd:FeatureDraft {draftId: $draftId, teamId: $teamId})
    SET fd.payload = $payload, fd.createdAt = datetime()
  `,
    opts,
    "saveGapDraft",
  );
}

/** Load a saved gap draft payload (JSON string) or null. */
export async function getGapDraft(
  draftId: string,
  teamId: string,
): Promise<string | null> {
  const records = await runQuery(
    `
    MATCH (fd:FeatureDraft {draftId: $draftId, teamId: $teamId})
    RETURN fd.payload AS payload
  `,
    { draftId, teamId },
    "getGapDraft",
  );
  return (records[0]?.payload as string | undefined) ?? null;
}

/** Delete a gap draft once the feature is saved or the check is skipped. */
export async function deleteGapDraft(draftId: string, teamId: string) {
  await runQuery(
    `
    MATCH (fd:FeatureDraft {draftId: $draftId, teamId: $teamId})
    DETACH DELETE fd
  `,
    { draftId, teamId },
    "deleteGapDraft",
  );
}

// ---------------------------------------------------------------------------
// Plan-Execute-Verify agent
// ---------------------------------------------------------------------------

/** Minimal per-phase shape used to build the plan's graph relationships. */
export interface StoredPlanPhase {
  index: number;
  title: string;
  description: string;
  constraint: string | null;
  assignedTo: string | null;
  assignedName?: string | null;
}

export interface PlanRecord {
  id: string;
  featureTitle: string;
  channel: string;
  threadTs: string;
  status: "pending_approval" | "active" | "complete" | "cancelled";
  awaitingMod: boolean;
  completedPhases: number[];
  /** JSON-encoded full PlanPhase[] for faithful reconstruction. */
  phasesJson: string;
}

export interface ExpertByTopics {
  personId: string;
  personName: string;
  count: number;
}

/** People ranked by total DISCUSSED count across any of the given topics. */
export async function getExpertsByTopics(
  topics: string[],
  teamId: string,
  limit = 15,
): Promise<ExpertByTopics[]> {
  const keys = topics.map(normalizeTopic).filter(Boolean);
  if (keys.length === 0) return [];
  const records = await runQuery(
    `
    MATCH (p:Person {teamId: $teamId})-[r:DISCUSSED]->(t:Topic {teamId: $teamId})
    WHERE any(k IN $keys WHERE t.name CONTAINS k OR k CONTAINS t.name)
    RETURN p.slackId AS personId,
           p.name AS personName,
           sum(r.count) AS count
    ORDER BY count DESC
    LIMIT $limit
  `,
    { keys, teamId, limit: neo4j.int(limit) },
    "getExpertsByTopics",
  );
  return records.map((r) => ({
    personId: r.personId as string,
    personName: r.personName as string,
    count: r.count as number,
  }));
}

/** An existing feature/plan on a related topic, to warn about overlap. */
export async function getOverlappingFeatureTitle(
  topics: string[],
  teamId: string,
): Promise<string | null> {
  const keys = topics.map(normalizeTopic).filter(Boolean);
  if (keys.length === 0) return null;
  const records = await runQuery(
    `
    MATCH (f:Feature {teamId: $teamId})-[:ABOUT]->(t:Topic {teamId: $teamId})
    WHERE any(k IN $keys WHERE t.name CONTAINS k OR k CONTAINS t.name)
    RETURN f.title AS title
    LIMIT 1
  `,
    { keys, teamId },
    "getOverlappingFeatureTitle",
  );
  return (records[0]?.title as string | undefined) ?? null;
}

/**
 * Create or update a Plan node and rebuild its graph shape: INCLUDES_PHASE to
 * each assigned owner, CONSTRAINED_BY to shaping decisions, and FOR to any
 * matching Feature. The full phase list is also stored as JSON for reconstruction.
 */
export async function storePlan(opts: {
  planId: string;
  teamId: string;
  featureTitle: string;
  channel: string;
  threadTs: string;
  status: "pending_approval" | "active" | "complete";
  phases: StoredPlanPhase[];
  phasesJson: string;
  constraintDecisionIds: string[];
  featureTopic?: string;
}): Promise<string> {
  const assignedPhases = opts.phases
    .filter((p) => p.assignedTo)
    .map((p) => ({
      index: neo4j.int(p.index),
      title: p.title,
      description: p.description,
      constraint: p.constraint ?? "",
      ownerId: p.assignedTo as string,
      ownerName: p.assignedName ?? "",
    }));

  await runQuery(
    `
    MERGE (pl:Plan {id: $planId, teamId: $teamId})
    ON CREATE SET pl.createdAt = datetime(), pl.completedPhases = []
    SET pl.featureTitle = $featureTitle,
        pl.channel = $channel,
        pl.threadTs = $threadTs,
        pl.status = $status,
        pl.phasesJson = $phasesJson,
        pl.updatedAt = datetime()
    WITH pl
    OPTIONAL MATCH (pl)-[oldPhase:INCLUDES_PHASE]->()
    DELETE oldPhase
    WITH pl
    OPTIONAL MATCH (pl)-[oldConstraint:CONSTRAINED_BY]->()
    DELETE oldConstraint
    WITH pl
    UNWIND (CASE WHEN size($phases) = 0 THEN [null] ELSE $phases END) AS ph
    FOREACH (_ IN CASE WHEN ph IS NULL THEN [] ELSE [1] END |
      MERGE (owner:Person {slackId: ph.ownerId, teamId: $teamId})
      SET owner.name = CASE WHEN ph.ownerName <> "" THEN ph.ownerName ELSE owner.name END
      MERGE (pl)-[hp:INCLUDES_PHASE {index: ph.index}]->(owner)
      SET hp.title = ph.title, hp.description = ph.description, hp.constraint = ph.constraint
    )
  `,
    {
      planId: opts.planId,
      teamId: opts.teamId,
      featureTitle: opts.featureTitle,
      channel: opts.channel,
      threadTs: opts.threadTs,
      status: opts.status,
      phasesJson: opts.phasesJson,
      phases: assignedPhases,
    },
    "storePlan",
  );

  // Connect shaping decisions (elementId can't be MERGEd inside FOREACH).
  if (opts.constraintDecisionIds.length > 0) {
    await runQuery(
      `
      MATCH (pl:Plan {id: $planId, teamId: $teamId})
      MATCH (d:Decision {teamId: $teamId}) WHERE elementId(d) IN $ids
      MERGE (pl)-[:CONSTRAINED_BY]->(d)
    `,
      {
        planId: opts.planId,
        teamId: opts.teamId,
        ids: opts.constraintDecisionIds,
      },
      "linkPlanConstraints",
    );
  }

  // Connect to an existing Feature on the same topic, if any.
  if (opts.featureTopic) {
    await runQuery(
      `
      MATCH (pl:Plan {id: $planId, teamId: $teamId})
      MATCH (f:Feature {teamId: $teamId})-[:ABOUT]->(t:Topic {name: $topic, teamId: $teamId})
      MERGE (pl)-[:FOR]->(f)
    `,
      {
        planId: opts.planId,
        teamId: opts.teamId,
        topic: normalizeTopic(opts.featureTopic),
      },
      "linkPlanFeature",
    );
  }

  return opts.planId;
}

/** Update the status and/or awaiting-modification flag on a plan by thread. */
export async function setPlanState(
  threadTs: string,
  teamId: string,
  patch: {
    status?: "pending_approval" | "active" | "complete" | "cancelled";
    awaitingMod?: boolean;
  },
) {
  await runQuery(
    `
    MATCH (pl:Plan {threadTs: $threadTs, teamId: $teamId})
    SET pl.status = coalesce($status, pl.status),
        pl.awaitingMod = coalesce($awaitingMod, pl.awaitingMod)
  `,
    {
      threadTs,
      teamId,
      status: patch.status ?? null,
      awaitingMod: patch.awaitingMod ?? null,
    },
    "setPlanState",
  );
}

function toPlanRecord(row: Record<string, unknown>): PlanRecord {
  return {
    id: row.id as string,
    featureTitle: (row.featureTitle as string) ?? "",
    channel: (row.channel as string) ?? "",
    threadTs: (row.threadTs as string) ?? "",
    status: (row.status as PlanRecord["status"]) ?? "pending_approval",
    awaitingMod: Boolean(row.awaitingMod),
    completedPhases: (row.completedPhases as number[]) ?? [],
    phasesJson: (row.phasesJson as string) ?? "[]",
  };
}

/** The active/pending plan owning a thread, or null. */
export async function getPlanByThread(
  threadTs: string,
  teamId: string,
): Promise<PlanRecord | null> {
  const records = await runQuery(
    `
    MATCH (pl:Plan {threadTs: $threadTs, teamId: $teamId})
    RETURN pl.id AS id, pl.featureTitle AS featureTitle, pl.channel AS channel,
           pl.threadTs AS threadTs, pl.status AS status,
           coalesce(pl.awaitingMod, false) AS awaitingMod,
           coalesce(pl.completedPhases, []) AS completedPhases,
           pl.phasesJson AS phasesJson
    LIMIT 1
  `,
    { threadTs, teamId },
    "getPlanByThread",
  );
  return records[0] ? toPlanRecord(records[0]) : null;
}

/** The most recent active plan in a channel (used for completion detection). */
export async function getActivePlanForChannel(
  channel: string,
  teamId: string,
): Promise<PlanRecord | null> {
  const records = await runQuery(
    `
    MATCH (pl:Plan {channel: $channel, teamId: $teamId, status: "active"})
    RETURN pl.id AS id, pl.featureTitle AS featureTitle, pl.channel AS channel,
           pl.threadTs AS threadTs, pl.status AS status,
           coalesce(pl.awaitingMod, false) AS awaitingMod,
           coalesce(pl.completedPhases, []) AS completedPhases,
           pl.phasesJson AS phasesJson
    ORDER BY pl.updatedAt DESC
    LIMIT 1
  `,
    { channel, teamId },
    "getActivePlanForChannel",
  );
  return records[0] ? toPlanRecord(records[0]) : null;
}

/** Reassign a phase's owner: patch the stored JSON and the INCLUDES_PHASE edge. */
export async function updatePhaseOwner(
  planId: string,
  teamId: string,
  phaseIndex: number,
  newOwnerId: string,
  newOwnerName: string,
): Promise<void> {
  const records = await runQuery(
    `MATCH (pl:Plan {id: $planId, teamId: $teamId}) RETURN pl.phasesJson AS phasesJson`,
    { planId, teamId },
    "getPlanPhasesForReassign",
  );
  const phasesJson = (records[0]?.phasesJson as string | undefined) ?? "[]";
  let phases: Array<Record<string, unknown>>;
  try {
    phases = JSON.parse(phasesJson);
  } catch {
    phases = [];
  }
  const phase = phases.find((p) => p.index === phaseIndex);
  if (phase) {
    phase.assignedTo = newOwnerId;
    phase.assignedName = newOwnerName;
    phase.unassignedReason = null;
  }

  await runQuery(
    `
    MATCH (pl:Plan {id: $planId, teamId: $teamId})
    SET pl.phasesJson = $phasesJson, pl.updatedAt = datetime()
    WITH pl
    OPTIONAL MATCH (pl)-[old:INCLUDES_PHASE {index: $phaseIndex}]->()
    DELETE old
    WITH pl
    MERGE (owner:Person {slackId: $newOwnerId, teamId: $teamId})
    SET owner.name = $newOwnerName
    MERGE (pl)-[hp:INCLUDES_PHASE {index: $phaseIndex}]->(owner)
    SET hp.title = $title, hp.description = $description
  `,
    {
      planId,
      teamId,
      phasesJson: JSON.stringify(phases),
      phaseIndex: neo4j.int(phaseIndex),
      newOwnerId,
      newOwnerName,
      title: (phase?.title as string) ?? "",
      description: (phase?.description as string) ?? "",
    },
    "updatePhaseOwner",
  );
}

/** Mark a phase complete: add to completedPhases and flip its stored status. */
export async function markPhaseComplete(
  planId: string,
  teamId: string,
  phaseIndex: number,
): Promise<void> {
  const records = await runQuery(
    `MATCH (pl:Plan {id: $planId, teamId: $teamId}) RETURN pl.phasesJson AS phasesJson`,
    { planId, teamId },
    "getPlanPhasesForComplete",
  );
  const phasesJson = (records[0]?.phasesJson as string | undefined) ?? "[]";
  let phases: Array<Record<string, unknown>>;
  try {
    phases = JSON.parse(phasesJson);
  } catch {
    phases = [];
  }
  const phase = phases.find((p) => p.index === phaseIndex);
  if (phase) phase.status = "complete";

  await runQuery(
    `
    MATCH (pl:Plan {id: $planId, teamId: $teamId})
    SET pl.phasesJson = $phasesJson,
        pl.completedPhases =
          CASE WHEN $phaseIndex IN coalesce(pl.completedPhases, [])
               THEN pl.completedPhases
               ELSE coalesce(pl.completedPhases, []) + $phaseIndex END,
        pl.updatedAt = datetime()
  `,
    {
      planId,
      teamId,
      phasesJson: JSON.stringify(phases),
      phaseIndex: neo4j.int(phaseIndex),
    },
    "markPhaseComplete",
  );
}

// ---------------------------------------------------------------------------
// Home dashboard queries — team-wide rollups for the App Home tab.
// ---------------------------------------------------------------------------

/** Most recent decisions across all topics (not superseded), newest first. */
export async function getRecentDecisions(
  teamId: string,
  limit = 5,
): Promise<DecisionRecord[]> {
  const records = await runQuery(
    `
    MATCH (p:Person)-[:MADE]->(d:Decision {teamId: $teamId})
    WHERE coalesce(d.superseded, false) = false
    RETURN d.summary AS summary,
           p.slackId AS personId,
           p.name AS personName,
           d.channel AS channel,
           d.threadTs AS threadTs,
           toString(d.date) AS date
    ORDER BY d.date DESC
    LIMIT $limit
  `,
    { teamId, limit: neo4j.int(limit) },
    "getRecentDecisions",
  );
  return records as DecisionRecord[];
}

/** Unresolved blockers across all topics, newest first. */
export async function getActiveBlockers(
  teamId: string,
  limit = 5,
): Promise<BlockerRecord[]> {
  const records = await runQuery(
    `
    MATCH (p:Person)-[:SENT]->(m:Message {type: "blocker", teamId: $teamId})
    WHERE coalesce(m.resolved, false) = false
    RETURN m.text AS summary,
           p.slackId AS personId,
           p.name AS personName,
           m.channel AS channel,
           m.ts AS threadTs,
           toString(m.date) AS date
    ORDER BY m.date DESC
    LIMIT $limit
  `,
    { teamId, limit: neo4j.int(limit) },
    "getActiveBlockers",
  );
  return records as BlockerRecord[];
}

/** Plans that are still in flight (pending approval or active), newest first. */
export async function getActivePlansForTeam(
  teamId: string,
  limit = 5,
): Promise<PlanRecord[]> {
  const records = await runQuery(
    `
    MATCH (pl:Plan {teamId: $teamId})
    WHERE pl.status IN ["active", "pending_approval"]
    RETURN pl.id AS id,
           pl.featureTitle AS featureTitle,
           pl.channel AS channel,
           pl.threadTs AS threadTs,
           pl.status AS status,
           coalesce(pl.awaitingMod, false) AS awaitingMod,
           coalesce(pl.completedPhases, []) AS completedPhases,
           pl.phasesJson AS phasesJson
    ORDER BY pl.updatedAt DESC
    LIMIT $limit
  `,
    { teamId, limit: neo4j.int(limit) },
    "getActivePlansForTeam",
  );
  return records.map(toPlanRecord);
}

export interface TopicActivity {
  topic: string;
  activity: number;
}

/** Topics with the most decision/blocker activity since `sinceIso`, busiest first. */
export async function getMostDiscussedTopics(
  teamId: string,
  sinceIso: string,
  limit = 5,
): Promise<TopicActivity[]> {
  const records = await runQuery(
    `
    MATCH (n)-[:ABOUT|RAISED_CONCERN_ABOUT]->(t:Topic {teamId: $teamId})
    WHERE n.date IS NOT NULL AND n.date >= datetime($sinceIso)
    RETURN t.name AS topic, count(n) AS activity
    ORDER BY activity DESC
    LIMIT $limit
  `,
    { teamId, sinceIso, limit: neo4j.int(limit) },
    "getMostDiscussedTopics",
  );
  return records.map((r) => ({
    topic: r.topic as string,
    activity: r.activity as number,
  }));
}
