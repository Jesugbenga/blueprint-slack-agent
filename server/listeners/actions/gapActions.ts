import type {
  AllMiddlewareArgs,
  BlockAction,
  ButtonAction,
  SlackActionMiddlewareArgs,
} from "@slack/bolt";
import { deleteGapDraft, getGapDraft } from "~/lib/graph";
import {
  GAP_FILL_ACTION,
  type GapButtonValue,
  gapFillModal,
} from "~/lib/slack/gap-blocks";
import type { GapDraftPayload } from "~/listeners/events/featureRequestHandler";

/**
 * Handles the two gap buttons.
 * - "Fill in the gaps": open a modal pre-populated from the saved draft.
 * - "Skip — this is exploratory": drop the draft, store nothing.
 */
export const gapActionsCallback = async ({
  ack,
  action,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  const button = action as ButtonAction;
  let value: GapButtonValue;
  try {
    value = JSON.parse(button.value);
  } catch {
    logger.error("[gap] could not parse gap button value");
    return;
  }

  const teamId = body.team?.id;
  if (!teamId) return;

  if (button.action_id === GAP_FILL_ACTION) {
    const raw = await getGapDraft(value.draftId, teamId).catch(() => null);
    if (!raw) {
      logger.warn("[gap] draft not found (expired?)");
      return;
    }
    const payload = JSON.parse(raw) as GapDraftPayload;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: gapFillModal({
        analysis: {
          title: payload.title,
          topic: payload.topic,
          gaps: payload.gaps,
          dependencyNote: payload.dependencyNote,
        },
        draftId: value.draftId,
      }),
    });
    return;
  }

  // Skip — exploratory. Discard the draft without storing anything.
  await deleteGapDraft(value.draftId, teamId).catch((err) =>
    logger.error("[gap] deleteGapDraft failed:", err),
  );
  const channelId = body.channel?.id;
  const threadTs = body.message?.thread_ts || body.message?.ts;
  if (channelId) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "👍 No problem — I'll treat this as exploratory and won't track it.",
    });
  }
};
