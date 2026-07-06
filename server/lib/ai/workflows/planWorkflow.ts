import { randomUUID } from "node:crypto";
import { sleep } from "workflow";
import { detectContradiction } from "~/lib/ai/drift";
import { planDecisionHook, planModHook } from "~/lib/ai/workflows/hooks";
import type { TopicDecisionRecord } from "~/lib/graph";
import {
  getDecisionsAboutTopic,
  getExpertsByTopics,
  getOverlappingFeatureTitle,
  type StoredPlanPhase,
  setPlanState,
  storePlan,
} from "~/lib/graph";
import {
  buildGraphSummary,
  extractComponents,
  extractKeywords,
  generatePlanBlocks,
  type PlanDecision,
  type PlanExpert,
  type PlanPhase,
  parsePlanModification,
  planActionBlocks,
} from "~/lib/planner";
import { createSlackClient } from "~/lib/slack/client";

/**
 * 48-hour verify window. Lower this temporarily (e.g. "2 minutes") to demo the
 * autonomous follow-up ping.
 */
export const PLAN_VERIFY_DELAY = "48 hours";

export interface PlanWorkflowInput {
  channel: string;
  threadTs: string;
  userId: string;
  teamId: string;
  requestText: string;
}

interface GatherResult {
  featureTitle: string;
  phases: PlanPhase[];
  graphSummary: string;
  decisions: PlanDecision[];
  experts: PlanExpert[];
  constraintDecisionIds: string[];
  keywords: string[];
}

/**
 * The Plan → Execute → Verify loop. Generates a graph-grounded plan, suspends on
 * a hook for human approval (looping on adjust/reassign), stores the approved
 * plan, then autonomously follows up after the verify window.
 */
export async function planWorkflow(input: PlanWorkflowInput) {
  "use workflow";

  const planId = randomUUID();
  const gathered = await gatherAndPlan(input);
  let phases = gathered.phases;
  let warning: string | undefined;

  // Persist up front (pending_approval) so thread replies can be correlated.
  await persistPlan(input, planId, gathered, phases, "pending_approval");

  for (;;) {
    await postPlanMessage(
      input,
      phases,
      gathered.featureTitle,
      gathered.graphSummary,
      warning,
    );

    const decision = await planDecisionHook.create({ token: input.threadTs });

    if (decision.action === "approve") {
      await persistPlan(input, planId, gathered, phases, "active");
      await setPlanState(input.threadTs, input.teamId, { awaitingMod: false });
      await postThreadReply(
        input,
        "🔒 Plan locked. I'll check in on progress.",
      );
      break;
    }

    // adjust / reassign — ask for the change, then wait for the thread reply.
    await postThreadReply(
      input,
      decision.action === "adjust"
        ? "✏️ What should change? Reply in this thread and I'll re-plan."
        : "🔀 Which phase, and who should own it? Reply in this thread.",
    );
    await setPlanState(input.threadTs, input.teamId, { awaitingMod: true });

    const mod = await planModHook.create({ token: `${input.threadTs}:mod` });
    await setPlanState(input.threadTs, input.teamId, { awaitingMod: false });

    const applied = await applyModification(gathered, phases, mod.text);
    phases = applied.phases;
    warning = applied.warning;
    // Persist the interim (still pending) plan so reassignments survive.
    await persistPlan(input, planId, gathered, phases, "pending_approval");
  }

  // VERIFY — autonomous follow-up after the window.
  const approvedAtSec = Math.floor(Date.now() / 1000);
  await sleep(PLAN_VERIFY_DELAY);
  await runVerify(input, phases, approvedAtSec);
}

// ---------------------------------------------------------------------------
// Steps (I/O)
// ---------------------------------------------------------------------------

async function gatherAndPlan(input: PlanWorkflowInput): Promise<GatherResult> {
  const client = createSlackClient(process.env.SLACK_BOT_TOKEN as string);

  // Thinking state.
  await client.chat.postMessage({
    channel: input.channel,
    thread_ts: input.threadTs,
    text: "🔍 Checking your team's knowledge graph before planning...",
  });

  const keywords = await extractKeywords(input.requestText);
  const [rawDecisions, rawExperts, overlap] = await Promise.all([
    getDecisionsAboutTopic(keywords, input.teamId).catch(() => []),
    getExpertsByTopics(keywords, input.teamId).catch(() => []),
    getOverlappingFeatureTitle(keywords, input.teamId).catch(() => null),
  ]);

  const decisions: PlanDecision[] = rawDecisions.map((d) => ({
    id: d.id,
    summary: d.summary,
    topic: d.topic,
    channel: d.channel,
    threadTs: d.threadTs,
  }));
  const experts: PlanExpert[] = rawExperts.map((e) => ({
    personId: e.personId,
    personName: e.personName,
    count: e.count,
  }));

  const { featureTitle, phases } = await extractComponents(
    input.requestText,
    decisions,
    experts,
  );

  return {
    featureTitle,
    phases,
    graphSummary: buildGraphSummary(decisions.length, experts.length, overlap),
    decisions,
    experts,
    constraintDecisionIds: decisions.map((d) => d.id).filter(Boolean),
    keywords,
  };
}

async function postPlanMessage(
  input: PlanWorkflowInput,
  phases: PlanPhase[],
  featureTitle: string,
  graphSummary: string,
  warning?: string,
): Promise<void> {
  const client = createSlackClient(process.env.SLACK_BOT_TOKEN as string);
  await client.chat.postMessage({
    channel: input.channel,
    thread_ts: input.threadTs,
    blocks: [
      ...generatePlanBlocks(phases, featureTitle, graphSummary, warning),
      planActionBlocks(input.threadTs),
    ],
    text: `Plan for ${featureTitle}`,
  });
}

async function postThreadReply(
  input: PlanWorkflowInput,
  text: string,
): Promise<void> {
  const client = createSlackClient(process.env.SLACK_BOT_TOKEN as string);
  await client.chat.postMessage({
    channel: input.channel,
    thread_ts: input.threadTs,
    text,
  });
}

async function persistPlan(
  input: PlanWorkflowInput,
  planId: string,
  gathered: GatherResult,
  phases: PlanPhase[],
  status: "pending_approval" | "active" | "complete",
): Promise<void> {
  const stored: StoredPlanPhase[] = phases.map((p) => ({
    index: p.index,
    title: p.title,
    description: p.description,
    constraint: p.constraint,
    assignedTo: p.assignedTo,
    assignedName: p.assignedName,
  }));
  await storePlan({
    planId,
    teamId: input.teamId,
    featureTitle: gathered.featureTitle,
    channel: input.channel,
    threadTs: input.threadTs,
    status,
    phases: stored,
    phasesJson: JSON.stringify(phases),
    constraintDecisionIds: gathered.constraintDecisionIds,
    featureTopic: gathered.keywords[0],
  });
}

async function applyModification(
  gathered: GatherResult,
  phases: PlanPhase[],
  modText: string,
): Promise<{ phases: PlanPhase[]; warning?: string }> {
  const updated = await parsePlanModification(
    modText,
    phases,
    gathered.experts,
  );
  const finalPhases = updated.length > 0 ? updated : phases;

  // Re-check the modified plan against the team's decisions for contradictions.
  let warning: string | undefined;
  if (gathered.decisions.length > 0) {
    const planSummary = finalPhases
      .map((p) => `${p.title}: ${p.description}`)
      .join("; ");
    const asRecords: TopicDecisionRecord[] = gathered.decisions.map((d) => ({
      id: d.id,
      summary: d.summary,
      topic: d.topic,
      channel: d.channel,
      threadTs: d.threadTs,
      personId: "",
      personName: "",
      date: "",
    }));
    const verdict = await detectContradiction(planSummary, asRecords);
    if (verdict.contradiction && verdict.confidence > 0.75) {
      const clashed = asRecords[verdict.decisionIndex] ?? asRecords[0];
      warning = `This change may conflict with a stored decision — ${clashed.summary}. Confirm before you approve.`;
    }
  }

  return { phases: finalPhases, warning };
}

async function runVerify(
  input: PlanWorkflowInput,
  phases: PlanPhase[],
  approvedAtSec: number,
): Promise<void> {
  const client = createSlackClient(process.env.SLACK_BOT_TOKEN as string);

  // Who has posted in the channel since approval?
  let activeUsers = new Set<string>();
  try {
    const history = await client.conversations.history({
      channel: input.channel,
      oldest: String(approvedAtSec),
      limit: 200,
    });
    activeUsers = new Set(
      (history.messages ?? [])
        .map((m) => m.user)
        .filter((u): u is string => Boolean(u)),
    );
  } catch (err) {
    console.error("[plan-verify] history fetch failed:", err);
  }

  for (const phase of phases) {
    if (!phase.assignedTo) continue;
    if (activeUsers.has(phase.assignedTo)) continue;
    await client.chat.postMessage({
      channel: input.channel,
      thread_ts: input.threadTs,
      text: `👋 *Phase ${phase.index + 1} (${phase.title})* has been quiet since the plan was approved. <@${phase.assignedTo}>, is this on track or is something blocking you?`,
    });
  }
}
