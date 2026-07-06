import type {
  AllMiddlewareArgs,
  BlockAction,
  ButtonAction,
  SlackActionMiddlewareArgs,
} from "@slack/bolt";
import { resolveOpenItem } from "~/lib/graph";
import {
  HANDOFF_PICKUP_ACTION,
  type HandoffPickupValue,
} from "~/lib/slack/handoff-blocks";

/**
 * Handles the "Pick this up" button on an end-of-day handoff card: marks the
 * item resolved in the graph and acknowledges in the thread so the team knows
 * who owns it now.
 */
export const handoffPickupCallback = async ({
  ack,
  action,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  const button = action as ButtonAction;
  let value: HandoffPickupValue;
  try {
    value = JSON.parse(button.value);
  } catch {
    logger.error("[handoff] could not parse pickup value");
    return;
  }

  const userId = body.user.id;
  const teamId = body.team?.id;
  const channelId = body.channel?.id;

  if (teamId) {
    await resolveOpenItem(value.kind, value.id, teamId).catch((err) =>
      logger.error("[handoff] failed to resolve item:", err),
    );
  }

  if (channelId) {
    await client.chat.postMessage({
      channel: channelId,
      text: `🙌 <@${userId}> picked up: ${value.summary}`,
    });
  }
};

export { HANDOFF_PICKUP_ACTION };
