import { randomUUID } from "node:crypto";
import type {
  AllMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { generateScaffold } from "~/lib/ai/scaffold";
import { queryBlockers, queryDecisions, whoKnows } from "~/lib/graph";
import { deliverScaffold } from "~/lib/slack/scaffold-message";
import { slackPermalink } from "~/lib/slack/utils";

type RespondFn = SlackCommandMiddlewareArgs["respond"];

/** Everything a subcommand needs to reply and (for scaffolding) upload files. */
interface CommandCtx {
  respond: RespondFn;
  client: WebClient;
  teamId: string;
  channelId?: string;
  userId?: string;
}

interface ParsedCommand {
  sub: "context" | "who-knows" | "risks" | "scaffold" | "help";
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
  if (lower.startsWith("scaffold") || lower.startsWith("prototype")) {
    return {
      sub: "scaffold",
      arg: trimmed.replace(/^(scaffold|prototype)\s*/i, ""),
    };
  }
  return { sub: "help", arg: "" };
}

const HELP_TEXT = [
  "*Blueprint commands*",
  "• `/blueprint context <topic>` — decisions already made about a topic, with links to the original threads",
  "• `/blueprint who knows <topic>` — who on the team has the most context on a topic",
  "• `/blueprint risks <topic>` — open blockers and concerns raised about a topic",
  "• `/blueprint scaffold <feature description>` — turn an idea into a runnable prototype (schema + API + files)",
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

async function handleScaffold(arg: string, ctx: CommandCtx) {
  if (!arg) {
    await ctx.respond({
      response_type: "ephemeral",
      text: "Usage: `/blueprint scaffold <feature description>`",
    });
    return;
  }

  const { project, groundingDecisions, groundingBlockers } =
    await generateScaffold(arg, ctx.teamId);

  const grounded =
    groundingDecisions.length + groundingBlockers.length > 0
      ? `\n\n_Grounded in ${groundingDecisions.length} prior decision(s) and ${groundingBlockers.length} known blocker(s) from team memory._`
      : "";

  await deliverScaffold({
    project,
    scaffoldId: randomUUID(),
    topic: arg,
    description: arg,
    groundedNote: grounded,
    post: (m) =>
      ctx.respond({
        response_type: "in_channel",
        text: m.text,
        blocks: m.blocks,
      }),
    client: ctx.client,
    channelId: ctx.channelId,
  });
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
    case "scaffold":
      return handleScaffold(arg, ctx);
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
  // Ack immediately — AI scaffolding can exceed Slack's 3s limit, so the real
  // work runs in the background and is delivered via the response_url.
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
    try {
      await respond({
        response_type: "ephemeral",
        text: "Sorry, something went wrong handling that command.",
      });
    } catch (respondError) {
      logger.error("Also failed to send error response:", respondError);
    }
  });
};
