import { randomUUID } from "node:crypto";
import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { start } from "workflow/api";
import { detectContradiction, extractProposal } from "../../lib/ai/drift";
import { generateJson } from "../../lib/ai/json";
import { endOfDayHandoffWorkflow } from "../../lib/ai/workflows/handoff";
import { planModHook } from "../../lib/ai/workflows/hooks";
import { asyncRelayWorkflow } from "../../lib/ai/workflows/relay";
import { classifyMessage } from "../../lib/classifier";
import {
  getActivePlanForChannel,
  getDecisionsAboutTopic,
  getKnownTopics,
  getPlanByThread,
  markPhaseComplete,
  type PlanRecord,
  recordDiscussion,
  storeBlocker,
  storeDecision,
  storeQuestion,
  tryClaimHandoffSchedule,
} from "../../lib/graph";
import { driftBlocks } from "../../lib/slack/drift-blocks";
import { resolvePersonTimezone } from "../../lib/timezone";
import { handleFeatureRequest } from "./featureRequestHandler";
import { BUILD_INTENT } from "./planTrigger";

type MessageArgs = SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs;

export async function messageClassifier({
  event,
  client,
  context,
}: MessageArgs) {
  // Slack re-delivers an event (up to 3x) if we don't ack within ~3s. Skip
  // those retries so we don't classify the same message multiple times.
  if (context.retryNum) return;

  // Ignore bot messages, edits, deletions, and empty messages
  if ("subtype" in event && event.subtype) return;
  if ("bot_id" in event && event.bot_id) return;
  if (!("text" in event) || !event.text?.trim()) return;

  // Only classify real channel conversation. Direct messages and group DMs are
  // assistant chats already handled by the agent — classifying them here would
  // fire a second, redundant Gemini call per message (a major source of 429s).
  if (
    "channel_type" in event &&
    (event.channel_type === "im" || event.channel_type === "mpim")
  ) {
    return;
  }

  const userId = "user" in event ? event.user : null;
  if (!userId) return;

  // Tenant scope: every graph write is keyed to the workspace that sent the
  // event, so one team can never read or mutate another team's memory.
  const teamId = context.teamId;
  if (!teamId) return;

  // Fetch the real name from Slack — cached in-process so a busy channel
  // doesn't fire a users.info call on every single message.
  const userName = await resolveUserName(client, userId);

  const channel = event.channel;
  const threadTs =
    "thread_ts" in event && event.thread_ts ? event.thread_ts : event.ts;

  // PLAN — if this is a freeform reply inside a plan thread that's awaiting a
  // modification, route it into the workflow and stop (don't classify the
  // instruction as team chatter).
  if ("thread_ts" in event && event.thread_ts) {
    const routed = await routePlanModReply(
      event.thread_ts,
      event.text,
      teamId,
    ).catch(() => false);
    if (routed) {
      console.log("[Blueprint] routed plan modification reply");
      return;
    }
  }

  // FEATURE 2 — Decision Drift Detector. Kicked off in parallel so it never
  // blocks classification; awaited at the very end so the serverless function
  // doesn't freeze before the drift reply is posted. (Internally gated by a
  // cheap regex so most messages never hit the model.)
  //
  // Priority rule: the Plan-Execute-Verify agent (app_mention) outranks drift.
  // A bot @mention with build-intent language is (or will be) handled by the
  // plan workflow, so we skip drift on that same message to avoid both firing.
  const botUserId = context.botUserId;
  const isPlanRequest =
    !!botUserId &&
    event.text.includes(`<@${botUserId}>`) &&
    BUILD_INTENT.test(event.text.replace(/<@[^>]+>/g, ""));

  const driftPromise = isPlanRequest
    ? Promise.resolve()
    : runDriftCheck(client, event.text, channel, threadTs, teamId).catch(
        (err) => console.error("[drift] check failed:", err),
      );
  if (isPlanRequest) {
    console.log("[Blueprint] plan request — skipping drift on this message");
  }

  // FEATURE 1 — provision this user exactly once: cache their timezone (for
  // handoffs/relay) and start their daily end-of-day handoff workflow. Runs
  // concurrently and short-circuits via an in-process cache so most messages
  // skip it entirely.
  const provisionPromise = ensureUserProvisioned(
    client,
    userId,
    userName,
    teamId,
  ).catch((err) => console.error("[provision] failed:", err));

  // Classify the message, reusing existing topic labels to avoid graph
  // fragmentation. Known topics are cached briefly to save a read per message.
  const knownTopics = await getCachedKnownTopics(teamId);
  const classified = await classifyMessage(event.text, knownTopics);
  console.log(
    `[Blueprint] classified type=${classified.type} topic=${classified.topic ?? "-"}`,
  );

  if (classified.topic && classified.summary) {
    // Narrow once so the values stay `string` inside nested closures below.
    const topic = classified.topic;
    const summary = classified.summary;

    // The topic-discussion write and the type-specific write are independent,
    // so run them together instead of serializing two Neo4j round-trips.
    const writes: Array<Promise<unknown>> = [
      recordDiscussion(userId, userName, topic, teamId),
    ];

    if (classified.type === "decision") {
      writes.push(
        storeDecision({
          personId: userId,
          personName: userName,
          topic,
          summary,
          channel,
          threadTs,
          teamId,
        }),
      );
      console.log(`[Blueprint] Decision stored — topic: ${topic}`);
    } else if (classified.type === "blocker") {
      writes.push(
        storeBlocker({
          personId: userId,
          personName: userName,
          topic,
          summary,
          channel,
          threadTs,
          teamId,
        }),
      );
      console.log(`[Blueprint] Blocker stored — topic: ${topic}`);
    } else if (classified.type === "question") {
      // FEATURE 1 — Async Relay. Record the question, then arm the durable
      // relay workflow once it's stored.
      const questionId = randomUUID();
      writes.push(
        storeQuestion({
          questionId,
          personId: userId,
          personName: userName,
          text: event.text,
          channel,
          threadTs,
          teamId,
        }).then(() =>
          start(asyncRelayWorkflow, [
            {
              questionId,
              askerId: userId,
              askerName: userName,
              text: event.text,
              topic,
              channel,
              threadTs,
              teamId,
            },
          ]),
        ),
      );
      console.log(`[Blueprint] Relay armed — topic: ${topic}`);
    } else if (classified.type === "feature_request") {
      // FEATURE 3 — Context Gap Detector. Skipped when the Plan-Execute-Verify
      // agent already owns this message (a build-intent bot mention) so the two
      // don't both respond to the same request.
      if (isPlanRequest) {
        console.log(
          "[Blueprint] plan request — skipping gap check on this message",
        );
      } else {
        writes.push(
          handleFeatureRequest({
            client,
            text: event.text,
            channel,
            threadTs,
            teamId,
            topic,
          }),
        );
        console.log(`[Blueprint] Gap check run — topic: ${topic}`);
      }
    }

    await Promise.all(writes);
  }

  // PLAN — completion detection on ordinary channel chatter ("PR is up", etc.).
  await detectPlanCompletion(client, event.text, channel, teamId).catch((err) =>
    console.error("[plan-complete] check failed:", err),
  );

  // Let the parallel background work settle before the function returns.
  await Promise.all([driftPromise, provisionPromise]);
}

// ---------------------------------------------------------------------------
// In-process caches — cut redundant Slack/Neo4j round-trips on busy channels.
// These live for the lifetime of a warm serverless instance.
// ---------------------------------------------------------------------------

const nameCache = new Map<string, string>();
const scheduledUsers = new Set<string>();
const topicsCache = new Map<string, { topics: string[]; at: number }>();
const TOPICS_TTL_MS = 60_000;

/** Resolve a user's display name, caching it to avoid repeat users.info calls. */
async function resolveUserName(
  client: WebClient,
  userId: string,
): Promise<string> {
  const cached = nameCache.get(userId);
  if (cached) return cached;
  let name = "Unknown";
  try {
    const info = await client.users.info({ user: userId });
    name = info.user?.real_name || info.user?.name || "Unknown";
  } catch {
    // fall through with fallback
  }
  if (name !== "Unknown") nameCache.set(userId, name);
  return name;
}

/** Known topics per team, cached for a short window to save a read per message. */
async function getCachedKnownTopics(teamId: string): Promise<string[]> {
  const hit = topicsCache.get(teamId);
  if (hit && Date.now() - hit.at < TOPICS_TTL_MS) return hit.topics;
  const topics = await getKnownTopics(teamId).catch(() => hit?.topics ?? []);
  topicsCache.set(teamId, { topics, at: Date.now() });
  return topics;
}

/**
 * One-time per-user provisioning: cache their timezone on the Person node (for
 * handoffs/relay) and start their daily end-of-day handoff workflow. An
 * in-process Set short-circuits users already handled in this instance, so most
 * messages skip all of it. resolvePersonTimezone itself checks the Neo4j cache
 * first, so users.info is called at most once per user.
 */
async function ensureUserProvisioned(
  client: WebClient,
  userId: string,
  userName: string,
  teamId: string,
): Promise<void> {
  const key = `${teamId}:${userId}`;
  if (scheduledUsers.has(key)) return;
  scheduledUsers.add(key); // optimistic — prevents in-instance double work
  try {
    // Cache timezone/workdayEnd on the Person node on first sighting.
    await resolvePersonTimezone(client, userId, teamId, userName);

    const claimed = await tryClaimHandoffSchedule(userId, userName, teamId);
    if (claimed) {
      await start(endOfDayHandoffWorkflow, [
        { personId: userId, personName: userName, teamId },
      ]);
      console.log(`[Blueprint] scheduled end-of-day handoff for ${userName}`);
    }
  } catch (err) {
    scheduledUsers.delete(key); // allow a retry on the next message
    throw err;
  }
}

/**
 * PLAN — resume the plan workflow's modification hook when the user replies in a
 * plan thread that's awaiting an adjustment/reassignment. Returns true if it
 * consumed the message.
 */
async function routePlanModReply(
  threadTs: string,
  text: string,
  teamId: string,
): Promise<boolean> {
  const plan = await getPlanByThread(threadTs, teamId);
  if (!plan || !plan.awaitingMod) return false;
  // The mod hook token is keyed to the plan's id (unique per workflow run).
  await planModHook.resume(`${plan.id}:mod`, { text });
  return true;
}

const COMPLETION_HINT =
  /\b(merged|shipped|deployed|done|complete|completed|pr (is )?up|ready for review|finished|wrapped up)\b/i;

// Language that suggests a technical/architectural proposal worth a drift check.
const PROPOSAL_HINT =
  /\b(use|using|adopt|switch(ing)? to|migrat(e|ing) to|mov(e|ing) to|go(ing)? with|instead of|replace|drop|swap|prefer|let'?s use|we should use|pick|choose|choosing)\b/i;

/**
 * PLAN — watch for phase-completion signals in a channel with an active plan.
 * A cheap regex pre-filter gates the model confirmation to bound cost.
 */
async function detectPlanCompletion(
  client: WebClient,
  text: string,
  channel: string,
  teamId: string,
): Promise<void> {
  if (!COMPLETION_HINT.test(text)) return;

  // Cached (incl. negative) so common words like "done" don't trigger a DB read
  // on every message in channels that have no active plan.
  const plan = await getCachedActivePlan(channel, teamId);
  if (!plan) return;

  let phases: Array<{ index: number; title: string }>;
  try {
    phases = JSON.parse(plan.phasesJson);
  } catch {
    return;
  }
  if (!Array.isArray(phases) || phases.length === 0) return;

  const phaseList = phases.map((p) => `${p.index}: ${p.title}`).join("\n");
  const result = await generateJson<{ completed: boolean; phaseIndex: number }>(
    `A plan has these phases:
${phaseList}

A teammate posted: "${text.replace(/"/g, '\\"')}"

Does this message signal that one of the phases above is DONE/completed?
Return ONLY JSON: { "completed": true|false, "phaseIndex": <the phase index number, or -1> }.
No markdown, no code fences.`,
    { completed: false, phaseIndex: -1 },
    "plan-complete",
  );

  if (!result.completed || result.phaseIndex < 0) return;
  if (plan.completedPhases.includes(result.phaseIndex)) return;

  await markPhaseComplete(plan.id, teamId, result.phaseIndex);
  activePlanCache.delete(channel); // state changed — force a fresh read next time
  const phase = phases.find((p) => p.index === result.phaseIndex);
  await client.chat.postMessage({
    channel,
    thread_ts: plan.threadTs,
    text: `✅ Marked *Phase ${result.phaseIndex + 1}${phase ? ` (${phase.title})` : ""}* complete. Nice work!`,
  });
}

const activePlanCache = new Map<
  string,
  { plan: PlanRecord | null; at: number }
>();
const ACTIVE_PLAN_TTL_MS = 30_000;

/** Active plan for a channel, cached briefly (negatives included) to save reads. */
async function getCachedActivePlan(
  channel: string,
  teamId: string,
): Promise<PlanRecord | null> {
  const hit = activePlanCache.get(channel);
  if (hit && Date.now() - hit.at < ACTIVE_PLAN_TTL_MS) return hit.plan;
  const plan = await getActivePlanForChannel(channel, teamId).catch(
    () => hit?.plan ?? null,
  );
  activePlanCache.set(channel, { plan, at: Date.now() });
  return plan;
}

/**
 * FEATURE 2 — extract any technical proposal from a message, compare it against
 * prior decisions, and post a thread-reply warning when it genuinely
 * contradicts one (confidence > 0.75).
 */
async function runDriftCheck(
  client: WebClient,
  text: string,
  channel: string,
  threadTs: string,
  teamId: string,
): Promise<void> {
  // Cheap gate: only messages that sound like a technical proposal are worth a
  // model call. This keeps drift off the hot path for ordinary chatter.
  if (!PROPOSAL_HINT.test(text)) return;

  const proposal = await extractProposal(text);
  if (!proposal.isProposal || proposal.keywords.length === 0) return;

  const decisions = await getDecisionsAboutTopic(proposal.keywords, teamId);
  if (decisions.length === 0) return;

  const verdict = await detectContradiction(proposal.approach, decisions);
  if (!verdict.contradiction || verdict.confidence <= 0.75) return;

  const past = decisions[verdict.decisionIndex] ?? decisions[0];
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    blocks: driftBlocks({
      pastSummary: past.summary,
      pastDate: past.date,
      value: {
        oldDecisionId: past.id,
        topic: past.topic,
        approach: proposal.approach,
        sourceChannel: past.channel,
        sourceThreadTs: past.threadTs,
      },
    }),
    text: "⚠️ Heads up — this may contradict a past decision.",
  });
}
