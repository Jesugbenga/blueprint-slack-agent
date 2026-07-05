import type { AllMiddlewareArgs, SlackViewMiddlewareArgs } from "@slack/bolt";
import { newComponentId, type UIComponent } from "~/lib/ai/design";
import { recordDesignEdit } from "~/lib/graph";
import {
  readComponentFields,
  typeFromValues,
} from "~/lib/slack/design-blocks";
import { mutateAndRerender } from "~/lib/slack/design-service";

interface AddMeta {
  designId: string;
  channel: string;
  messageTs: string;
}

/** Append a new component from the "Add component" modal and re-render. */
const designAddViewCallback = async ({
  ack,
  view,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs) => {
  await ack();

  let meta: AddMeta;
  try {
    meta = JSON.parse(view.private_metadata);
  } catch {
    logger.error("Bad design add metadata");
    return;
  }

  const teamId = body.team?.id;
  if (!teamId) return;

  const type = typeFromValues(view.state.values);
  const fields = readComponentFields(type, view.state.values);
  const component: UIComponent = { id: newComponentId(), type, ...fields };

  const ok = await mutateAndRerender(client, {
    designId: meta.designId,
    teamId,
    channel: meta.channel,
    messageTs: meta.messageTs,
    mutate: (spec) => [...spec, component],
  });

  if (ok) {
    await recordDesignEdit({
      designId: meta.designId,
      teamId,
      action: "add",
      detail: `Added ${type} component`,
      byId: body.user.id,
      byName: body.user.name || body.user.id,
    }).catch((err) => logger.error("recordDesignEdit failed:", err));
  }
};

export default designAddViewCallback;
