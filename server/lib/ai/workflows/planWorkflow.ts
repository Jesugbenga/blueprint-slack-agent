import { sleep } from "workflow";
import { detectContradiction } from "~/lib/ai/drift";
import { planDecisionHook, planModHook } from "~/lib/ai/workflows/hooks";
import type { StoredPlanPhase, TopicDecisionRecord } from "~/lib/graph";
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

/**
 * Verify window before the autonomous follow-up. DEMO: "1 minute". Restore to
 * "48 hours" for production.
 */
export const PLAN_VERIFY_DELAY = "1 minute";

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

  const planId = crypto.randomUUID();
  const gathered = await gatherAndPlan(input);
  let phases = gathered.phases;
  let warning: string | undefined;

  // Persist up front (pending_approval) so thread replies can be correlated.
  await persistPlan(input, planId, gathered, phases, "pending_approval");

  for (;;) {
    await postPlanMessage(
      input,
      planId,
      phases,
      gathered.featureTitle,
      gathered.graphSummary,
      warning,
    );

    const decision = await planDecisionHook.create({ token: planId });

    if (decision.action === "approve") {
      await persistPlan(input, planId, gathered, phases, "active");
      await setAwaiting(input, false);
      await postThreadReply(
        input,
        "🔒 Plan locked. I'll check in on progress.",
      );
      break;
    }

    if (decision.action === "cancel") {
      // Terminal: drop the plan and skip the verify follow-up entirely.
      await markPlanCancelled(input);
      await postThreadReply(
        input,
        "🛑 Plan cancelled — nothing was scheduled.",
      );
      return;
    }

    // adjust / reassign — ask for the change, then wait for the thread reply.
    await postThreadReply(
      input,
      decision.action === "adjust"
        ? "✏️ What should change? Reply in this thread and I'll re-plan."
        : "🔀 Which phase, and who should own it? Reply in this thread.",
    );
    await setAwaiting(input, true);

    const mod = await planModHook.create({ token: `${planId}:mod` });
    await setAwaiting(input, false);

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
  "use step";
  const { createSlackClient } = await import("~/lib/slack/client");
  const {
    getDecisionsAboutTopic,
    getExpertsByTopics,
    getOverlappingFeatureTitle,
  } = await import("~/lib/graph");
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
  planId: string,
  phases: PlanPhase[],
  featureTitle: string,
  graphSummary: string,
  warning?: string,
): Promise<void> {
  "use step";
  const { createSlackClient } = await import("~/lib/slack/client");
  const client = createSlackClient(process.env.SLACK_BOT_TOKEN as string);
  await client.chat.postMessage({
    channel: input.channel,
    thread_ts: input.threadTs,
    blocks: [
      ...generatePlanBlocks(phases, featureTitle, graphSummary, warning),
      planActionBlocks(planId),
    ],
    text: `Plan for ${featureTitle}`,
  });
}

async function postThreadReply(
  input: PlanWorkflowInput,
  text: string,
): Promise<void> {
  "use step";
  const { createSlackClient } = await import("~/lib/slack/client");
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
  "use step";
  const { storePlan } = await import("~/lib/graph");
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

/** Flip the plan's awaiting-modification flag (in a step so graph stays out of the orchestrator). */
async function setAwaiting(
  input: PlanWorkflowInput,
  awaitingMod: boolean,
): Promise<void> {
  "use step";
  const { setPlanState } = await import("~/lib/graph");
  await setPlanState(input.threadTs, input.teamId, { awaitingMod });
}

/** Mark a plan cancelled (in a step so graph stays out of the orchestrator). */
async function markPlanCancelled(input: PlanWorkflowInput): Promise<void> {
  "use step";
  const { setPlanState } = await import("~/lib/graph");
  await setPlanState(input.threadTs, input.teamId, {
    status: "cancelled",
    awaitingMod: false,
  });
}

async function applyModification(
  gathered: GatherResult,
  phases: PlanPhase[],
  modText: string,
): Promise<{ phases: PlanPhase[]; warning?: string }> {
  "use step";
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
  "use step";
  const { createSlackClient } = await import("~/lib/slack/client");
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
