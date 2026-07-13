import type { KnownBlock } from "@slack/web-api";
import { generateJson } from "~/lib/ai/json";
import { slackPermalink } from "~/lib/slack/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanPhase {
  index: number;
  title: string;
  description: string;
  /** Related decision summary if this phase is shaped by a constraint. */
  constraint: string | null;
  constraintThreadTs: string | null;
  /** Person slackId the phase is assigned to, or null. */
  assignedTo: string | null;
  assignedName: string | null;
  /** e.g. "8 auth discussions". */
  assignmentReason: string | null;
  /** e.g. "No compliance expertise on this team". */
  unassignedReason: string | null;
  status: "pending" | "active" | "complete" | "blocked";
}

export interface Plan {
  id: string;
  featureTitle: string;
  phases: PlanPhase[];
  channel: string;
  threadTs: string;
  status: "pending_approval" | "active" | "complete";
  completedPhases: number[];
}

/** Decision the plan can be constrained by (subset of graph's TopicDecisionRecord). */
export interface PlanDecision {
  id: string;
  summary: string;
  topic: string;
  channel: string;
  threadTs: string;
}

/** Expert candidate ranked by discussion activity. */
export interface PlanExpert {
  personId: string;
  personName: string;
  count: number;
}

export const PLAN_APPROVE_ACTION = "plan_approve";
export const PLAN_ADJUST_ACTION = "plan_adjust";
export const PLAN_REASSIGN_ACTION = "plan_reassign";
export const PLAN_CANCEL_ACTION = "plan_cancel";

/** Small payload carried on the plan buttons. Carries the per-run plan id,
 * which is used as the decision-hook token (unique per workflow run). */
export interface PlanButtonValue {
  planId: string;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

interface ModelPhase {
  title: string;
  description: string;
  constraint: string | null;
  ownerName: string | null;
  assignmentReason: string | null;
  unassignedReason: string | null;
}

interface ModelPlan {
  featureTitle: string;
  phases: ModelPhase[];
}

/** Map a model-produced phase to a full PlanPhase, resolving the owner name to a slackId. */
function resolvePhase(
  mp: ModelPhase,
  index: number,
  experts: PlanExpert[],
  decisions: PlanDecision[],
): PlanPhase {
  const expert = mp.ownerName
    ? experts.find(
        (e) => e.personName.toLowerCase() === mp.ownerName?.toLowerCase(),
      )
    : undefined;

  // Attach a thread link if the constraint text matches a known decision.
  const decision = mp.constraint
    ? decisions.find(
        (d) =>
          mp.constraint &&
          (d.summary.includes(mp.constraint) ||
            mp.constraint.includes(d.summary.slice(0, 24))),
      )
    : undefined;

  return {
    index,
    title: mp.title,
    description: mp.description,
    constraint: mp.constraint,
    constraintThreadTs: decision?.threadTs ?? null,
    assignedTo: expert?.personId ?? null,
    assignedName: expert?.personName ?? null,
    assignmentReason: expert ? mp.assignmentReason : null,
    unassignedReason: expert
      ? null
      : (mp.unassignedReason ?? "No clear owner on this team"),
    status: "pending",
  };
}

/**
 * Decompose a natural-language feature request into 2–5 contextual phases,
 * shaped by the team's decisions and staffed from its actual expertise graph.
 */
export async function extractComponents(
  requestText: string,
  decisions: PlanDecision[],
  experts: PlanExpert[],
): Promise<{ featureTitle: string; phases: PlanPhase[] }> {
  const decisionsBlock =
    decisions.length > 0
      ? decisions.map((d) => `- ${d.summary}`).join("\n")
      : "(none found)";
  const expertsBlock =
    experts.length > 0
      ? experts
          .map((e) => `- ${e.personName} (${e.count} related discussions)`)
          .join("\n")
      : "(no expertise recorded)";

  const fallback: ModelPlan = {
    featureTitle: requestText.slice(0, 80),
    phases: [],
  };

  const result = await generateJson<ModelPlan>(
    `You are Blueprint. Break a feature/product build request into a CONTEXTUAL plan of 2–5 phases.
Shape it using the team's actual decisions and expertise below — do NOT produce a generic template.

Feature request: "${requestText.replace(/"/g, '\\"')}"

Team decisions already made (these are CONSTRAINTS — respect them, e.g. if they chose OAuth2, the auth phase reflects that):
${decisionsBlock}

Team members ranked by relevant discussion activity (assign phases to REAL people from this list):
${expertsBlock}

Return ONLY a JSON object:
- "featureTitle": short title for the feature
- "phases": array of 2–5 phases, each:
  - "title": phase name
  - "description": one sentence on what it covers
  - "constraint": the exact decision summary from the list above that shapes this phase, or null
  - "ownerName": the EXACT name from the members list best suited to own it, or null if nobody has relevant expertise
  - "assignmentReason": short reason when assigned (e.g. "8 auth discussions"), else null
  - "unassignedReason": short reason when unassigned (e.g. "No compliance expertise on this team"), else null

Return ONLY valid JSON. No markdown, no code fences.`,
    fallback,
    "plan-extract",
  );

  const phases = (result.phases ?? []).map((mp, i) =>
    resolvePhase(mp, i, experts, decisions),
  );
  return { featureTitle: result.featureTitle || fallback.featureTitle, phases };
}

/**
 * Re-parse the full plan after a freeform modification ("swap phase 1 and 2",
 * "DevOps owns compliance"). Returns the complete updated phase list.
 */
export async function parsePlanModification(
  modificationText: string,
  currentPlan: PlanPhase[],
  experts: PlanExpert[],
): Promise<PlanPhase[]> {
  const planBlock = currentPlan
    .map(
      (p) =>
        `${p.index + 1}. ${p.title} — ${p.description} [owner: ${p.assignedName ?? "unassigned"}]`,
    )
    .join("\n");
  const expertsBlock =
    experts.length > 0
      ? experts.map((e) => `- ${e.personName}`).join("\n")
      : "(no expertise recorded)";

  const fallback = { phases: [] as ModelPhase[] };

  const result = await generateJson<{ phases: ModelPhase[] }>(
    `You are Blueprint. Apply a requested modification to an existing plan and return the FULL updated plan.

Current plan:
${planBlock}

Available owners (assign only from this list, match by exact name):
${expertsBlock}

Modification requested: "${modificationText.replace(/"/g, '\\"')}"

Apply the change (reorder, edit, or reassign phases as asked) and return ONLY a JSON object:
- "phases": the COMPLETE updated array IN THE NEW ORDER, each { "title", "description", "constraint" (or null), "ownerName" (exact name or null), "assignmentReason" (or null), "unassignedReason" (or null) }

Return ONLY valid JSON. No markdown, no code fences.`,
    fallback,
    "plan-modify",
  );

  const phases = result.phases?.length ? result.phases : [];
  // Preserve prior constraint thread links by matching on constraint text.
  const decisionsFromPlan: PlanDecision[] = currentPlan
    .filter((p) => p.constraint)
    .map((p) => ({
      id: "",
      summary: p.constraint as string,
      topic: "",
      channel: "",
      threadTs: p.constraintThreadTs ?? "",
    }));

  return phases.map((mp, i) => resolvePhase(mp, i, experts, decisionsFromPlan));
}

// ---------------------------------------------------------------------------
// Block Kit
// ---------------------------------------------------------------------------

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** Render the plan as a Block Kit message with per-phase sections and 3 buttons. */
export function generatePlanBlocks(
  phases: PlanPhase[],
  feature: string,
  graphSummary: string,
  warning?: string,
): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🗂️ Plan — ${truncate(feature, 100)}`,
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: graphSummary }],
    },
  ];

  if (warning) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `⚠️ ${warning}` },
    });
  }

  blocks.push({ type: "divider" });

  phases.forEach((phase, idx) => {
    const lines = [
      `*Phase ${phase.index + 1} · ${phase.title}*`,
      phase.description,
    ];

    if (phase.constraint) {
      const link = slackPermalink(null, phase.constraintThreadTs);
      const linkText = link ? ` (<${link}|decision thread>)` : "";
      lines.push(
        `📌 _Shaped by:_ ${truncate(phase.constraint, 200)}${linkText}`,
      );
    }

    if (phase.assignedTo) {
      lines.push(
        `👤 *Owner:* <@${phase.assignedTo}>${phase.assignmentReason ? ` — ${phase.assignmentReason}` : ""}`,
      );
    } else {
      lines.push(
        `⚠️ *Unassigned* — ${phase.unassignedReason ?? "no clear owner"}`,
      );
    }

    if (idx > 0) blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    });
  });

  blocks.push({ type: "divider" });
  return blocks;
}

/** The three approval/adjust/reassign buttons, carrying the plan's thread ts. */
export function planActionBlocks(planId: string): KnownBlock {
  const value = JSON.stringify({ planId } satisfies PlanButtonValue);
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Looks good — start", emoji: true },
        style: "primary",
        action_id: PLAN_APPROVE_ACTION,
        value,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Adjust plan", emoji: true },
        action_id: PLAN_ADJUST_ACTION,
        value,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Reassign a phase", emoji: true },
        action_id: PLAN_REASSIGN_ACTION,
        value,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Cancel", emoji: true },
        style: "danger",
        action_id: PLAN_CANCEL_ACTION,
        value,
      },
    ],
  };
}

/** One-line summary of what the graph lookup found, for the plan header context. */
export function buildGraphSummary(
  decisionCount: number,
  expertCount: number,
  overlappingFeature: string | null,
): string {
  const parts = [
    `Found *${decisionCount}* related decision(s) and *${expertCount}* potential owner(s) in your knowledge graph.`,
  ];
  if (overlappingFeature) {
    parts.push(
      `⚠️ This overlaps with an existing plan: *${overlappingFeature}*.`,
    );
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Request classification + keyword extraction
// ---------------------------------------------------------------------------

/**
 * Classify a bare @mention (bot mention already stripped) as a *planning*
 * request ("help us build X", "break down X", "design X") vs a *query*
 * ("who knows X", "context on X"). Only planning requests start the workflow.
 */
export async function isPlanningRequest(requestText: string): Promise<boolean> {
  const result = await generateJson<{ planning: boolean }>(
    `Classify this message directed at a team assistant.

Message: "${requestText.replace(/"/g, '\\"')}"

Is it a PLANNING request (asking to build/design/break down/scope a feature or product —
e.g. "help us build Google Login", "break down the checkout redesign", "design a landing page")?
Or is it a QUERY (asking for information — e.g. "who knows auth", "context on billing", "what are the risks")?

Return ONLY a JSON object: { "planning": true } if it's a planning/build request, else { "planning": false }.
No markdown, no code fences.`,
    { planning: false },
    "plan-classify",
  );
  return result.planning === true;
}

/** Pull 1–4 topic keywords from a request for graph lookups. */
export async function extractKeywords(requestText: string): Promise<string[]> {
  const result = await generateJson<{ keywords: string[] }>(
    `Extract 1-4 short lowercase topic keywords from this feature request for a knowledge-graph lookup.

Request: "${requestText.replace(/"/g, '\\"')}"

Return ONLY a JSON object: { "keywords": ["...", "..."] }. No markdown, no code fences.`,
    { keywords: [] },
    "plan-keywords",
  );
  return Array.isArray(result.keywords) ? result.keywords.slice(0, 4) : [];
}
