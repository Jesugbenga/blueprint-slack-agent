import type { AllMiddlewareArgs, SlackViewMiddlewareArgs } from "@slack/bolt";
import type { ComponentType } from "~/lib/ai/design";
import { recordDesignEdit } from "~/lib/graph";
import { readComponentFields } from "~/lib/slack/design-blocks";
import { mutateAndRerender } from "~/lib/slack/design-service";

interface EditMeta {
  designId: string;
  channel: string;
  messageTs: string;
  componentId: string;
  type: ComponentType;
}

/** Apply edits from the "Edit component" modal and re-render the design. */
const designEditViewCallback = async ({
  ack,
  view,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs) => {
  await ack();

  let meta: EditMeta;
  try {
    meta = JSON.parse(view.private_metadata);
  } catch {
    logger.error("Bad design edit metadata");
    return;
  }

  const teamId = body.team?.id;
  if (!teamId) return;

  const fields = readComponentFields(meta.type, view.state.values);

  const ok = await mutateAndRerender(client, {
    designId: meta.designId,
    teamId,
    channel: meta.channel,
    messageTs: meta.messageTs,
    mutate: (spec) =>
      spec.map((c) =>
        c.id === meta.componentId ? { ...c, ...fields, type: meta.type } : c,
      ),
  });

  if (ok) {
    await recordDesignEdit({
      designId: meta.designId,
      teamId,
      action: "edit",
      detail: `Edited ${meta.type} component ${meta.componentId}`,
      byId: body.user.id,
      byName: body.user.name || body.user.id,
    }).catch((err) => logger.error("recordDesignEdit failed:", err));
  }
};

export default designEditViewCallback;
