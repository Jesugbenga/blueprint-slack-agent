import type { App } from "@slack/bolt";
import { CHANNEL_JOIN_APPROVAL_ACTION } from "~/lib/slack/blocks";
import {
  DRIFT_KEEP_ORIGINAL_ACTION,
  DRIFT_NEW_DIRECTION_ACTION,
} from "~/lib/slack/drift-blocks";
import { GAP_FILL_ACTION, GAP_SKIP_ACTION } from "~/lib/slack/gap-blocks";
import { HANDOFF_PICKUP_ACTION } from "~/lib/slack/handoff-blocks";
import { channelJoinApprovalCallback } from "./channel-join-approval";
import { driftResponseCallback } from "./drift-response";
import { feedbackButtonsCallback } from "./feedback-button-action";
import { gapActionsCallback } from "./gapActions";
import { handoffPickupCallback } from "./handoff-action";
import { planActions } from "./planActions";
import sampleActionCallback from "./sample-action";

const register = (app: App) => {
  app.action("sample_action_id", sampleActionCallback);
  app.action("feedback", feedbackButtonsCallback);
  // Channel join approval actions (approve and reject buttons)
  app.action(CHANNEL_JOIN_APPROVAL_ACTION, channelJoinApprovalCallback);
  app.action(
    `${CHANNEL_JOIN_APPROVAL_ACTION}_reject`,
    channelJoinApprovalCallback,
  );
  // Feature 1 — end-of-day handoff "Pick this up" button
  app.action(HANDOFF_PICKUP_ACTION, handoffPickupCallback);
  // Feature 2 — decision drift response buttons
  app.action(DRIFT_NEW_DIRECTION_ACTION, driftResponseCallback);
  app.action(DRIFT_KEEP_ORIGINAL_ACTION, driftResponseCallback);
  // Feature 3 — context gap buttons
  app.action(GAP_FILL_ACTION, gapActionsCallback);
  app.action(GAP_SKIP_ACTION, gapActionsCallback);
  // Plan-Execute-Verify buttons (approve / adjust / reassign)
  planActions(app);
};

export default { register };
