import type { KnownBlock, WebClient } from "@slack/web-api";
import {
  type ActiveBlocker,
  type DecisionRecord,
  getActiveBlockers,
  getActivePlansForTeam,
  getMostDiscussedTopics,
  getOpenItemsForPerson,
  getRecentDecisions,
  type OpenItem,
  type PlanRecord,
  type TopicActivity,
} from "~/lib/graph";
import { slackPermalink } from "./utils";

export const DASHBOARD_RESOLVE_BLOCKER = "dashboard_resolve_blocker";
export const DASHBOARD_COMPLETE_PHASE = "dashboard_complete_phase";
export const DASHBOARD_COMPLETE_PLAN = "dashboard_complete_plan";
export const DASHBOARD_REFRESH = "dashboard_refresh";

/** Button payload for resolving a blocker from the dashboard. */
export interface ResolveBlockerValue {
  id: string;
}

/** Button payload for marking a plan phase complete from the dashboard. */
export interface CompletePhaseValue {
  planId: string;
  phaseIndex: number;
}

/** Button payload for closing out a whole plan from the dashboard. */
export interface CompletePlanValue {
  planId: string;
}

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

function sourceLink(channel?: string | null, ts?: string | null): string {
  const link = slackPermalink(channel, ts);
  return link ? `  <${link}|↗ open>` : "";
}

function header(text: string): KnownBlock {
  return { type: "header", text: { type: "plain_text", text, emoji: true } };
}

function context(text: string): KnownBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function divider(): KnownBlock {
  return { type: "divider" };
}

/** Slack-native relative date, e.g. "today", "yesterday", "Jul 13". */
function whenText(iso?: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return `<!date^${Math.floor(t / 1000)}^{date_short_pretty}|recently>`;
}

/** A 12-slot unicode progress bar with a trailing percentage. */
function progressBar(done: number, total: number): string {
  if (!total) return "`────────────`  n/a";
  const slots = 12;
  const filled = Math.max(
    0,
    Math.min(slots, Math.round((done / total) * slots)),
  );
  const pct = Math.round((done / total) * 100);
  return `\`${"█".repeat(filled)}${"░".repeat(slots - filled)}\`  *${pct}%*`;
}

/** "5+" when a capped list is at its limit, else the plain count. */
function countLabel(len: number, cap: number): string {
  return len >= cap ? `${cap}+` : String(len);
}

/** KPI row: four stat "cards" laid out as section fields (2×2 grid). */
function statRow(counts: {
  decisions: number;
  blockers: number;
  plans: number;
  topics: number;
}): KnownBlock {
  return {
    type: "section",
    fields: [
      {
        type: "mrkdwn",
        text: `🧠  *${countLabel(counts.decisions, 5)}*\nDecisions`,
      },
      {
        type: "mrkdwn",
        text: `⛔  *${countLabel(counts.blockers, 5)}*\nOpen blockers`,
      },
      {
        type: "mrkdwn",
        text: `🗂️  *${countLabel(counts.plans, 5)}*\nActive plans`,
      },
      {
        type: "mrkdwn",
        text: `🔥  *${countLabel(counts.topics, 5)}*\nHot topics`,
      },
    ],
  };
}

/** Personalized "waiting on you" list from the viewer's open items. */
function yourItemsSection(items: OpenItem[]): KnownBlock[] {
  if (items.length === 0) {
    return [context("✨  You're all caught up — nothing waiting on you.")];
  }
  const emoji: Record<OpenItem["kind"], string> = {
    blocker: "⛔",
    question: "❓",
    decision: "📌",
  };
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: items
          .slice(0, 6)
          .map(
            (i) =>
              `${emoji[i.kind]}  ${truncate(i.summary, 160)}${sourceLink(i.channel, i.threadTs)}`,
          )
          .join("\n"),
      },
    },
  ];
}

function decisionsSection(decisions: DecisionRecord[]): KnownBlock[] {
  if (decisions.length === 0) return [context("_No decisions recorded yet._")];
  return decisions.map((d) => ({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `🟢  ${truncate(d.summary, 200)}\n_${d.personName} · ${whenText(d.date)}_${sourceLink(d.channel, d.threadTs)}`,
    },
  }));
}

/** Each active blocker with a "Resolve" button that closes it from the dashboard. */
function blockersSection(blockers: ActiveBlocker[]): KnownBlock[] {
  if (blockers.length === 0) {
    return [context("✨  *No active blockers* — the team is unblocked.")];
  }
  return blockers.map((b) => ({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `🔴  ${truncate(b.summary, 180)}\n_${b.personName} · ${whenText(b.date)}_${sourceLink(b.channel, b.threadTs)}`,
    },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: "✓ Resolve", emoji: true },
      style: "primary",
      action_id: DASHBOARD_RESOLVE_BLOCKER,
      value: JSON.stringify({ id: b.id } satisfies ResolveBlockerValue),
    },
  }));
}

/**
 * Each active plan with its phases. Incomplete phases of an *active* plan get a
 * "Mark done" button so they can be checked off straight from the dashboard.
 */
function plansSection(plans: PlanRecord[]): KnownBlock[] {
  if (plans.length === 0) {
    return [
      context(
        "No active plans. Start one with `@Blueprint break down <feature>`.",
      ),
    ];
  }

  const blocks: KnownBlock[] = [];
  plans.forEach((pl, i) => {
    let phases: Array<{ index: number; title: string }> = [];
    try {
      phases = JSON.parse(pl.phasesJson);
    } catch {
      phases = [];
    }
    const done = new Set(pl.completedPhases);
    const total = phases.length;
    const completed = phases.filter((p) => done.has(p.index)).length;
    const badge =
      pl.status === "pending_approval" ? "  ⏳ _awaiting approval_" : "";
    const link = slackPermalink(pl.channel, pl.threadTs);
    const title = link
      ? `<${link}|${truncate(pl.featureTitle, 80)}>`
      : truncate(pl.featureTitle, 80);

    if (i > 0) blocks.push(divider());
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${title}*${badge}\n${progressBar(completed, total)}  ·  ${completed}/${total} phases`,
      },
    });

    if (phases.length === 0) {
      blocks.push(context("_No phases recorded._"));
      return;
    }

    for (const p of phases) {
      if (done.has(p.index)) {
        blocks.push(
          context(`✅  ~Phase ${p.index + 1}: ${truncate(p.title, 140)}~`),
        );
      } else {
        // Every incomplete phase gets a side button, like the blockers list.
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `⬜  *Phase ${p.index + 1}:* ${truncate(p.title, 140)}`,
          },
          accessory: {
            type: "button",
            text: { type: "plain_text", text: "Mark done", emoji: true },
            action_id: DASHBOARD_COMPLETE_PHASE,
            value: JSON.stringify({
              planId: pl.id,
              phaseIndex: p.index,
            } satisfies CompletePhaseValue),
          },
        });
      }
    }

    // Once every phase is checked off, offer to close out the whole plan.
    if (total > 0 && completed === total) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "✓ Mark plan complete",
              emoji: true,
            },
            style: "primary",
            action_id: DASHBOARD_COMPLETE_PLAN,
            value: JSON.stringify({
              planId: pl.id,
            } satisfies CompletePlanValue),
          },
        ],
      });
    }
  });
  return blocks;
}

function topicsSection(topics: TopicActivity[]): KnownBlock[] {
  if (topics.length === 0) {
    return [context("_No topic activity in the last 7 days._")];
  }
  const max = Math.max(...topics.map((t) => t.activity), 1);
  const lines = topics.map((t) => {
    const len = Math.max(1, Math.round((t.activity / max) * 10));
    const bar = `${"▉".repeat(len)}${"▁".repeat(10 - len)}`;
    return `\`${bar}\`  *${t.topic}*  ·  ${t.activity}`;
  });
  return [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
  ];
}

/** Assemble the full Home dashboard from the team's graph. */
export async function buildDashboard(
  teamId: string,
  userId?: string,
): Promise<KnownBlock[]> {
  const weekAgoIso = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [decisions, blockers, plans, topics, yourItems] = await Promise.all([
    getRecentDecisions(teamId, 5),
    getActiveBlockers(teamId, 5),
    getActivePlansForTeam(teamId, 5),
    getMostDiscussedTopics(teamId, weekAgoIso, 5),
    userId
      ? getOpenItemsForPerson(userId, teamId).catch(() => [] as OpenItem[])
      : Promise.resolve([] as OpenItem[]),
  ]);

  const blocks: KnownBlock[] = [
    header("📐  Blueprint"),
    context(
      `*Team command center*  ·  updated ${whenText(new Date().toISOString())}`,
    ),
    statRow({
      decisions: decisions.length,
      blockers: blockers.length,
      plans: plans.length,
      topics: topics.length,
    }),
    divider(),
  ];

  if (userId) {
    blocks.push(
      header("👤  Waiting on you"),
      ...yourItemsSection(yourItems),
      divider(),
    );
  }

  blocks.push(
    header("🧠  Recent decisions"),
    ...decisionsSection(decisions),
    divider(),
    header("⛔  Active blockers"),
    ...blockersSection(blockers),
    divider(),
    header("🗂️  Active plans"),
    ...plansSection(plans),
    divider(),
    header("🔥  Trending this week"),
    ...topicsSection(topics),
    divider(),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "🔄  Refresh", emoji: true },
          action_id: DASHBOARD_REFRESH,
          value: "refresh",
        },
      ],
    },
    context(
      "💡  Mention `@Blueprint` in any channel to log a decision, ask a question, or break down a feature.",
    ),
  );

  return blocks;
}

/**
 * Build and publish the Home dashboard for a user. Falls back to a non-blank
 * diagnostic view if the graph can't be reached. Used by the app_home_opened
 * handler and by the interactive dashboard buttons to refresh in place.
 */
export async function publishHomeDashboard(
  client: WebClient,
  userId: string,
  teamId: string | undefined,
): Promise<void> {
  try {
    const blocks = teamId
      ? await buildDashboard(teamId, userId)
      : [
          header("📐 Blueprint"),
          context(
            "I couldn't determine your workspace, so I can't load the dashboard.",
          ),
        ];
    await client.views.publish({
      user_id: userId,
      view: { type: "home", blocks },
    });
  } catch (error) {
    console.error("[dashboard] publish failed:", error);
    try {
      await client.views.publish({
        user_id: userId,
        view: {
          type: "home",
          blocks: [
            header("📐 Blueprint"),
            context(
              "⚠️ Couldn't load the dashboard. This usually means the knowledge graph (Neo4j) is unreachable — check the `NEO4J_*` env vars and that the database is running.",
            ),
          ],
        },
      });
    } catch (publishError) {
      console.error("[dashboard] fallback publish failed:", publishError);
    }
  }
}
