import { randomUUID } from "node:crypto";
import type { AllMiddlewareArgs, SlackViewMiddlewareArgs } from "@slack/bolt";
import { generateScaffold } from "~/lib/ai/scaffold";
import {
  deliverScaffold,
  type ScaffoldPoster,
} from "~/lib/slack/scaffold-message";

interface ModifyMeta {
  scaffoldId: string;
  topic: string;
  description: string;
  channelId?: string;
  messageTs?: string;
}

/**
 * Handles the "Modify prototype" modal: regenerates the scaffold with the
 * reviewer's requested changes and posts a fresh review card + files.
 */
const scaffoldModifyViewCallback = async ({
  ack,
  view,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs) => {
  await ack();

  let meta: ModifyMeta;
  try {
    meta = JSON.parse(view.private_metadata);
  } catch {
    logger.error("Could not parse scaffold modify metadata");
    return;
  }

  const modText = view.state.values.modify_block?.modify_input?.value ?? "";
  const userId = body.user.id;
  const teamId = body.team?.id;
  if (!teamId) {
    logger.error("Scaffold modify: missing team id");
    return;
  }

  // Regeneration takes longer than Slack's 3s ack window, so run it after ack.
  (async () => {
    const description = `${meta.description}\n\nRequested changes from reviewer: ${modText}`;
    const { project, groundingDecisions, groundingBlockers } =
      await generateScaffold(description, teamId, meta.topic);

    const grounded =
      groundingDecisions.length + groundingBlockers.length > 0
        ? `\n\n_Grounded in ${groundingDecisions.length} prior decision(s) and ${groundingBlockers.length} known blocker(s) from team memory._`
        : "";

    const channelId = meta.channelId;
    const post: ScaffoldPoster = async (m) => {
      try {
        return await client.chat.postMessage({
          channel: channelId ?? userId,
          text: m.text,
          blocks: m.blocks,
        });
      } catch {
        // Bot may not be a member of the channel — fall back to a DM.
        return await client.chat.postMessage({
          channel: userId,
          text: m.text,
          blocks: m.blocks,
        });
      }
    };

    await deliverScaffold({
      project,
      scaffoldId: randomUUID(),
      topic: meta.topic,
      description,
      groundedNote: grounded,
      post,
      client,
      channelId,
    });
  })().catch(async (error) => {
    logger.error("Scaffold regeneration failed:", error);
    try {
      await client.chat.postEphemeral({
        channel: meta.channelId ?? userId,
        user: userId,
        text: "Sorry, I couldn't regenerate that prototype.",
      });
    } catch (notifyError) {
      logger.error("Also failed to notify user of error:", notifyError);
    }
  });
};

export default scaffoldModifyViewCallback;
