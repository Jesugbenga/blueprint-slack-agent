import type {
  AllMiddlewareArgs,
  BlockAction,
  ButtonAction,
  OverflowAction,
  SlackActionMiddlewareArgs,
} from "@slack/bolt";
import { storeDecision } from "~/lib/graph";
import { recordDesignEdit, updateDesignSpec } from "~/lib/graph";
import {
  addComponentModal,
  designIdFromMessage,
  editComponentModal,
} from "~/lib/slack/design-blocks";
import {
  loadDesignState,
  mutateAndRerender,
  rerenderDesignMessage,
} from "~/lib/slack/design-service";

type ActionArgs = AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>;

function actorName(body: BlockAction): string {
  return body.user.username || body.user.name || body.user.id;
}

/** Overflow menu on each component: Edit (open modal) or Remove (delete + re-render). */
export const designComponentMenuCallback = async ({
  ack,
  action,
  body,
  client,
  logger,
}: ActionArgs) => {
  await ack();

  const overflow = action as OverflowAction;
  const teamId = body.team?.id;
  const channel = body.channel?.id;
  const messageTs = body.message?.ts;
  const designId = body.message
    ? designIdFromMessage(
        body.message as { blocks?: Array<{ block_id?: string }> },
      )
    : null;
  if (!teamId || !channel || !messageTs || !designId) return;

  let selection: { op: "edit" | "remove"; id: string };
  try {
    selection = JSON.parse(overflow.selected_option.value);
  } catch {
    logger.error("Bad design component menu value");
    return;
  }

  if (selection.op === "edit") {
    const state = await loadDesignState(designId, teamId);
    if (!state || state.status === "approved") return;
    const component = state.spec.find((c) => c.id === selection.id);
    if (!component) return;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: editComponentModal({ designId, channel, messageTs, component }),
    });
    return;
  }

  // Remove
  const ok = await mutateAndRerender(client, {
    designId,
    teamId,
    channel,
    messageTs,
    mutate: (spec) => spec.filter((c) => c.id !== selection.id),
  });
  if (ok) {
    await recordDesignEdit({
      designId,
      teamId,
      action: "remove",
      detail: `Removed component ${selection.id}`,
      byId: body.user.id,
      byName: actorName(body),
    }).catch((err) => logger.error("recordDesignEdit failed:", err));
  }
};

/** "Add block" button: open the add-component modal. */
export const designAddBlockCallback = async ({
  ack,
  action,
  body,
  client,
  logger,
}: ActionArgs) => {
  await ack();

  const button = action as ButtonAction;
  const designId = button.value;
  const teamId = body.team?.id;
  const channel = body.channel?.id;
  const messageTs = body.message?.ts;
  if (!designId || !teamId || !channel || !messageTs) return;

  const state = await loadDesignState(designId, teamId);
  if (!state || state.status === "approved") return;

  await client.views
    .open({
      trigger_id: body.trigger_id,
      view: addComponentModal({ designId, channel, messageTs }),
    })
    .catch((err) => logger.error("Failed to open add-component modal:", err));
};

/** "Approve design" button: lock it, log the decision, tag an expert, pin it. */
export const designApproveCallback = async ({
  ack,
  action,
  body,
  client,
  logger,
}: ActionArgs) => {
  await ack();

  const button = action as ButtonAction;
  const designId = button.value;
  const teamId = body.team?.id;
  const channel = body.channel?.id;
  const messageTs = body.message?.ts;
  if (!designId || !teamId || !channel || !messageTs) return;

  const state = await loadDesignState(designId, teamId);
  if (!state || state.status === "approved") return;

  // Lock the design and re-render as approved.
  await updateDesignSpec({
    designId,
    teamId,
    spec: JSON.stringify(state.spec),
    status: "approved",
  });
  await rerenderDesignMessage(client, {
    designId,
    channel,
    messageTs,
    state: { ...state, status: "approved" },
  });

  const approver = actorName(body);
  const expert = state.enrichment.experts[0];
  const expertMention = expert ? `<@${expert.id}>` : null;

  // Final agreed spec summary posted into the thread.
  const specSummary = state.spec
    .map((c, i) => `${i + 1}. *${c.type}* — ${c.label ?? c.text ?? ""}`.trim())
    .join("\n");
  const summaryText = `✅ *Design approved: ${state.title}*\nApproved by <@${body.user.id}>.\n\n*Agreed UI spec*\n${specSummary}${
    expertMention
      ? `\n\n*Suggested to implement:* ${expertMention}`
      : ""
  }`;

  const posted = await client.chat.postMessage({
    channel,
    thread_ts: messageTs,
    text: `Design approved: ${state.title}`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: summaryText } }],
  });

  // Pin the summary so the agreed spec is easy to find (best-effort).
  if (posted.ts) {
    await client.pins
      .add({ channel, timestamp: posted.ts })
      .catch((err) => logger.warn("Could not pin design summary:", err));
  }

  // Log the approval as a team decision in the knowledge graph.
  await storeDecision({
    personId: body.user.id,
    personName: approver,
    topic: state.title,
    summary: `Approved UI design "${state.title}" (${state.spec.length} components)`,
    channel,
    threadTs: messageTs,
    teamId,
  }).catch((err) => logger.error("storeDecision failed:", err));

  await recordDesignEdit({
    designId,
    teamId,
    action: "approve",
    detail: `Approved by ${approver}`,
    byId: body.user.id,
    byName: approver,
  }).catch((err) => logger.error("recordDesignEdit failed:", err));
};
