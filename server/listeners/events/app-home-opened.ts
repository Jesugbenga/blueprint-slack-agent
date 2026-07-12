import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import type { KnownBlock } from "@slack/web-api";
import {
  type BlockerRecord,
  type DecisionRecord,
  getActiveBlockers,
  getActivePlansForTeam,
  getMostDiscussedTopics,
  getRecentDecisions,
  type PlanRecord,
  type TopicActivity,
} from "~/lib/graph";
import { slackPermalink } from "~/lib/slack/utils";

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

function sourceLink(channel?: string | null, ts?: string | null): string {
  const link = slackPermalink(channel, ts);
  return link ? ` <${link}|↗>` : "";
}

function header(text: string): KnownBlock {
  return { type: "header", text: { type: "plain_text", text, emoji: true } };
}

function context(text: string): KnownBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

/** Section listing recent decisions, or an empty-state note. */
function decisionsSection(decisions: DecisionRecord[]): KnownBlock[] {
  if (decisions.length === 0) return [context("No decisions recorded yet.")];
  return decisions.map((d) => ({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `• ${truncate(d.summary, 220)} — _${d.personName}_${sourceLink(d.channel, d.threadTs)}`,
    },
  }));
}

function blockersSection(blockers: BlockerRecord[]): KnownBlock[] {
  if (blockers.length === 0) return [context("No active blockers. 🎉")];
  return blockers.map((b) => ({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `⛔ ${truncate(b.summary, 220)} — _${b.personName}_${sourceLink(b.channel, b.threadTs)}`,
    },
  }));
}

function plansSection(plans: PlanRecord[]): KnownBlock[] {
  if (plans.length === 0) {
    return [
      context(
        "No active plans. Start one with `@Blueprint break down <feature>`.",
      ),
    ];
  }
  return plans.map((pl) => {
    let phases: Array<{ index: number; title: string }> = [];
    try {
      phases = JSON.parse(pl.phasesJson);
    } catch {
      phases = [];
    }
    const done = new Set(pl.completedPhases);
    const total = phases.length;
    const completed = phases.filter((p) => done.has(p.index)).length;
    const statusLabel =
      pl.status === "pending_approval" ? " _(awaiting approval)_" : "";
    const phaseLines =
      phases.length > 0
        ? phases
            .map(
              (p) =>
                `${done.has(p.index) ? "✅" : "⬜"} Phase ${p.index + 1}: ${truncate(p.title, 80)}`,
            )
            .join("\n")
        : "_No phases recorded._";
    const link = slackPermalink(pl.channel, pl.threadTs);
    const title = link
      ? `<${link}|${truncate(pl.featureTitle, 80)}>`
      : truncate(pl.featureTitle, 80);
    return {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${title}* — ${completed}/${total} phases done${statusLabel}\n${phaseLines}`,
      },
    };
  });
}

function topicsSection(topics: TopicActivity[]): KnownBlock[] {
  if (topics.length === 0) {
    return [context("No topic activity in the last 7 days.")];
  }
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: topics
          .map((t) => `• *${t.topic}* — ${t.activity} update(s)`)
          .join("\n"),
      },
    },
  ];
}

/** Assemble the full Home dashboard from the team's graph. */
async function buildDashboard(teamId: string): Promise<KnownBlock[]> {
  const weekAgoIso = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [decisions, blockers, plans, topics] = await Promise.all([
    getRecentDecisions(teamId, 5),
    getActiveBlockers(teamId, 5),
    getActivePlansForTeam(teamId, 5),
    getMostDiscussedTopics(teamId, weekAgoIso, 5),
  ]);

  return [
    header("📐 Blueprint — Team Dashboard"),
    context(
      "Your team's living memory: decisions, risks, plans, and what's hot this week.",
    ),
    { type: "divider" },
    header("🧠 Recent decisions"),
    ...decisionsSection(decisions),
    { type: "divider" },
    header("⛔ Active blockers"),
    ...blockersSection(blockers),
    { type: "divider" },
    header("🗂️ Active plans"),
    ...plansSection(plans),
    { type: "divider" },
    header("🔥 Most discussed this week"),
    ...topicsSection(topics),
  ];
}

const appHomeOpenedCallback = async ({
  client,
  event,
  context: ctx,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_home_opened">) => {
  // Ignore the `app_home_opened` event for anything but the Home tab
  if (event.tab !== "home") return;

  const teamId = ctx.teamId;

  try {
    const blocks = teamId
      ? await buildDashboard(teamId)
      : [
          header("📐 Blueprint"),
          context(
            "I couldn't determine your workspace, so I can't load the dashboard.",
          ),
        ];

    await client.views.publish({
      user_id: event.user,
      view: { type: "home", blocks },
    });
  } catch (error) {
    logger.error("app_home_opened handler failed:", error);
    // Never leave the tab blank — show a diagnostic instead.
    try {
      await client.views.publish({
        user_id: event.user,
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
      logger.error("Failed to publish fallback home view:", publishError);
    }
  }
};

export default appHomeOpenedCallback;
