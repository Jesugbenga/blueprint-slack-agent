import type {
  AllMiddlewareArgs,
  BlockAction,
  ButtonAction,
  SlackActionMiddlewareArgs,
} from "@slack/bolt";
import { storeDecision } from "~/lib/graph";
import {
  SCAFFOLD_APPROVE_ACTION,
  SCAFFOLD_MODIFY_ACTION,
  type ScaffoldReviewValue,
} from "~/lib/slack/blocks";

/**
 * Handles the Approve / Modify / Reject buttons on a generated prototype card.
 * - Approve: mark the card resolved and record the approval in team memory.
 * - Reject: mark the card resolved.
 * - Modify: open a modal so the reviewer can request changes and regenerate.
 */
export const scaffoldReviewCallback = async ({
  ack,
  action,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  const button = action as ButtonAction;
  let value: ScaffoldReviewValue;
  try {
    value = JSON.parse(button.value);
  } catch {
    logger.error("Could not parse scaffold review value");
    return;
  }

  const actionId = button.action_id;
  const userId = body.user.id;
  const userName = body.user.username || body.user.name || userId;
  const channelId = body.channel?.id;
  const messageTs = body.message?.ts;
  const teamId = body.team?.id;

  if (actionId === SCAFFOLD_MODIFY_ACTION) {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "scaffold_modify_view",
        private_metadata: JSON.stringify({
          scaffoldId: value.scaffoldId,
          topic: value.topic,
          description: value.description,
          channelId,
          messageTs,
        }),
        title: { type: "plain_text", text: "Modify prototype" },
        submit: { type: "plain_text", text: "Regenerate" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "modify_block",
            label: {
              type: "plain_text",
              text: "What should change?",
            },
            element: {
              type: "plain_text_input",
              action_id: "modify_input",
              multiline: true,
              placeholder: {
                type: "plain_text",
                text: "e.g. use Postgres instead of SQLite, add auth, split the API into two services",
              },
            },
          },
        ],
      },
    });
    return;
  }

  const approved = actionId === SCAFFOLD_APPROVE_ACTION;

  if (channelId && messageTs) {
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: approved ? "Prototype approved" : "Prototype rejected",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${
              approved ? "✅ *Approved*" : "🗑️ *Rejected*"
            } by <@${userId}> — ${value.summary}`,
          },
        },
      ],
    });
  }

  if (approved && teamId) {
    // Record the approval as a decision so it shows up in team memory.
    storeDecision({
      personId: userId,
      personName: userName,
      topic: value.topic,
      summary: `Approved prototype: ${value.summary}`,
      channel: channelId ?? "",
      threadTs: messageTs ?? "",
      teamId,
    }).catch((err) => logger.error("Failed to record scaffold approval:", err));
  }
};
