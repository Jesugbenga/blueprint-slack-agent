import type {
  AllMiddlewareArgs,
  BlockAction,
  ButtonAction,
  SlackActionMiddlewareArgs,
} from "@slack/bolt";
import { summarizeNewDirection } from "~/lib/ai/drift";
import { createDecision, flagDriftFalsePositive, supersede } from "~/lib/graph";
import {
  DRIFT_NEW_DIRECTION_ACTION,
  type DriftValue,
} from "~/lib/slack/drift-blocks";

/**
 * Handles the two drift buttons.
 * - "New direction": record a new decision that SUPERSEDES the old one.
 * - "Never mind": keep the original and flag the intervention as a false positive.
 */
export const driftResponseCallback = async ({
  ack,
  action,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  const button = action as ButtonAction;
  let value: DriftValue;
  try {
    value = JSON.parse(button.value);
  } catch {
    logger.error("[drift] could not parse drift value");
    return;
  }

  const userId = body.user.id;
  const userName = body.user.username || body.user.name || userId;
  const teamId = body.team?.id;
  const channelId = body.channel?.id;
  const threadTs = body.message?.thread_ts || body.message?.ts;

  if (!teamId || !channelId) return;

  if (button.action_id === DRIFT_NEW_DIRECTION_ACTION) {
    const summary = await summarizeNewDirection(value.approach, value.approach);
    const newId = await createDecision({
      personId: userId,
      personName: userName,
      topic: value.topic,
      summary,
      channel: channelId,
      threadTs: threadTs ?? "",
      teamId,
    }).catch((err) => {
      logger.error("[drift] createDecision failed:", err);
      return null;
    });

    if (newId) {
      await supersede(newId, value.oldDecisionId, teamId).catch((err) =>
        logger.error("[drift] supersede failed:", err),
      );
    }

    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `✅ Updated the record — this now supersedes the earlier decision.\n>${summary}`,
    });
    return;
  }

  // Keep original — log the false positive so the detector can improve.
  await flagDriftFalsePositive(value.oldDecisionId, teamId).catch((err) =>
    logger.error("[drift] flagDriftFalsePositive failed:", err),
  );
  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: "👍 Got it — keeping the original decision. I'll remember this wasn't a real conflict.",
  });
};
