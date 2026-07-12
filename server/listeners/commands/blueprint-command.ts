import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { start } from "workflow/api";
import { planWorkflow } from "~/lib/ai/workflows/planWorkflow";
import { queryBlockers, queryDecisions, whoKnows } from "~/lib/graph";
import { slackPermalink } from "~/lib/slack/utils";

type RespondFn = SlackCommandMiddlewareArgs["respond"];

/** Everything a subcommand needs to reply and (for planning) anchor a thread. */
interface CommandCtx {
  respond: RespondFn;
  client: WebClient;
  teamId: string;
  channelId?: string;
  userId?: string;
}

interface ParsedCommand {
  sub: "context" | "who-knows" | "risks" | "plan" | "help";
  arg: string;
}

/** Parse the raw slash command text into a subcommand + argument. */
export function parseBlueprintCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (!trimmed) return { sub: "help", arg: "" };

  const lower = trimmed.toLowerCase();

  if (lower.startsWith("who knows") || lower.startsWith("who-knows")) {
    return { sub: "who-knows", arg: trimmed.replace(/^who[\s-]knows\s*/i, "") };
  }
  if (lower.startsWith("context")) {
    return { sub: "context", arg: trimmed.replace(/^context\s*/i, "") };
  }
  if (lower.startsWith("risks")) {
    return { sub: "risks", arg: trimmed.replace(/^risks\s*/i, "") };
  }
  if (lower.startsWith("plan")) {
    return { sub: "plan", arg: trimmed.replace(/^plan\s*/i, "") };
  }
  return { sub: "help", arg: "" };
}

const HELP_TEXT = [
  "*Blueprint commands*",
  "• `/blueprint context <topic>` — decisions already made about a topic, with links to the original threads",
  "• `/blueprint who knows <topic>` — who on the team has the most context on a topic",
  "• `/blueprint risks <topic>` — open blockers and concerns raised about a topic",
  "• `/blueprint plan <feature description>` — run a Plan-Execute-Verify breakdown grounded in your team's graph",
].join("\n");

function citation(channel?: string | null, ts?: string | null): string {
  const link = slackPermalink(channel, ts);
  return link ? ` (<${link}|source>)` : "";
}

async function handleContext(arg: string, teamId: string, respond: RespondFn) {
  if (!arg) {
    await respond({
      response_type: "ephemeral",
      text: "Usage: `/blueprint context <topic>`",
    });
    return;
  }
  const decisions = await queryDecisions(arg, teamId);
  if (decisions.length === 0) {
    await respond({
      response_type: "ephemeral",
      text: `I have no decisions recorded about *${arg}* yet.`,
    });
    return;
  }
  const lines = decisions.map(
    (d) =>
      `• ${d.summary} — _${d.personName}_${citation(d.channel, d.threadTs)}`,
  );
  await respond({
    response_type: "ephemeral",
    text: `*Decisions about ${arg}*\n${lines.join("\n")}`,
  });
}

async function handleRisks(arg: string, teamId: string, respond: RespondFn) {
  if (!arg) {
    await respond({
      response_type: "ephemeral",
      text: "Usage: `/blueprint risks <topic>`",
    });
    return;
  }
  const blockers = await queryBlockers(arg, teamId);
  if (blockers.length === 0) {
    await respond({
      response_type: "ephemeral",
      text: `No blockers or concerns recorded about *${arg}* yet. 🎉`,
    });
    return;
  }
  const lines = blockers.map(
    (b) =>
      `• ${b.summary} — _${b.personName}_${citation(b.channel, b.threadTs)}`,
  );
  await respond({
    response_type: "ephemeral",
    text: `*Open risks for ${arg}*\n${lines.join("\n")}`,
  });
}

async function handleWhoKnows(arg: string, teamId: string, respond: RespondFn) {
  if (!arg) {
    await respond({
      response_type: "ephemeral",
      text: "Usage: `/blueprint who knows <topic>`",
    });
    return;
  }
  const experts = await whoKnows(arg, teamId);
  if (experts.length === 0) {
    await respond({
      response_type: "ephemeral",
      text: `Nobody has discussed *${arg}* in my memory yet.`,
    });
    return;
  }
  const lines = experts.map(
    (e) => `• <@${e.personId}> — ${e.count} mention(s)`,
  );
  await respond({
    response_type: "ephemeral",
    text: `*Who knows about ${arg}*\n${lines.join("\n")}`,
  });
}

/**
 * Manually kick off a Plan-Execute-Verify breakdown from a slash command. Posts
 * an anchor message to thread the plan under, then starts the durable workflow.
 */
async function handlePlan(arg: string, ctx: CommandCtx) {
  if (!arg) {
    await ctx.respond({
      response_type: "ephemeral",
      text: "Usage: `/blueprint plan <describe the feature to plan>`",
    });
    return;
  }
  if (!ctx.channelId) {
    await ctx.respond({
      response_type: "ephemeral",
      text: "I can only plan from within a channel.",
    });
    return;
  }

  const anchor = await ctx.client.chat.postMessage({
    channel: ctx.channelId,
    text: `📋 Planning: ${arg}`,
  });
  const threadTs = anchor.ts;
  if (!threadTs) return;

  await start(planWorkflow, [
    {
      channel: ctx.channelId,
      threadTs,
      userId: ctx.userId ?? "",
      teamId: ctx.teamId,
      requestText: arg,
    },
  ]);
}

/**
 * Run the requested subcommand. Separated from the Bolt handler so it can run
 * in the background (fire-and-forget) after we ack within Slack's 3s window.
 */
export async function runBlueprintCommand(text: string, ctx: CommandCtx) {
  const { sub, arg } = parseBlueprintCommand(text);
  switch (sub) {
    case "context":
      return handleContext(arg, ctx.teamId, ctx.respond);
    case "risks":
      return handleRisks(arg, ctx.teamId, ctx.respond);
    case "who-knows":
      return handleWhoKnows(arg, ctx.teamId, ctx.respond);
    case "plan":
      return handlePlan(arg, ctx);
    default:
      return ctx.respond({ response_type: "ephemeral", text: HELP_TEXT });
  }
}

export const blueprintCommandCallback = async ({
  ack,
  command,
  respond,
  client,
  logger,
}: AllMiddlewareArgs & SlackCommandMiddlewareArgs) => {
  // Ack immediately — the real work (AI planning) can exceed Slack's 3s limit,
  // so it runs in the background and is delivered via the response_url.
  await ack();

  const ctx: CommandCtx = {
    respond,
    client,
    teamId: command.team_id,
    channelId: command.channel_id,
    userId: command.user_id,
  };

  runBlueprintCommand(command.text ?? "", ctx).catch(async (error) => {
    logger.error("Blueprint command failed:", error);
    const detail = error instanceof Error ? error.message : String(error);
    // Surface the real cause to the invoking user (ephemeral — only they see it).
    const looksLikeDb =
      /neo4j|ServiceUnavailable|SessionExpired|authentication|unauthorized|Pool|ECONNRESET|ETIMEDOUT|connection/i.test(
        detail,
      );
    const hint = looksLikeDb
      ? "\n\nThis looks like a *knowledge-graph (Neo4j) connection* problem. Check the `NEO4J_*` environment variables on the server match the running instance, then redeploy."
      : "";
    try {
      await respond({
        response_type: "ephemeral",
        text: `⚠️ Couldn't handle that command.\n\`\`\`${detail.slice(0, 400)}\`\`\`${hint}`,
      });
    } catch (respondError) {
      logger.error("Also failed to send error response:", respondError);
    }
  });
};
