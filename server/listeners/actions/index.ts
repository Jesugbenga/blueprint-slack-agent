import type { App } from "@slack/bolt";
import { CHANNEL_JOIN_APPROVAL_ACTION } from "~/lib/slack/blocks";
import {
  DASHBOARD_COMPLETE_PHASE,
  DASHBOARD_COMPLETE_PLAN,
  DASHBOARD_REFRESH,
  DASHBOARD_RESOLVE_BLOCKER,
} from "~/lib/slack/dashboard";
import {
  DRIFT_KEEP_ORIGINAL_ACTION,
  DRIFT_NEW_DIRECTION_ACTION,
} from "~/lib/slack/drift-blocks";
import { GAP_FILL_ACTION, GAP_SKIP_ACTION } from "~/lib/slack/gap-blocks";
import { HANDOFF_PICKUP_ACTION } from "~/lib/slack/handoff-blocks";
import { channelJoinApprovalCallback } from "./channel-join-approval";
import {
  completePhaseCallback,
  completePlanCallback,
  refreshDashboardCallback,
  resolveBlockerCallback,
} from "./dashboard-actions";
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
  // Interactive Home dashboard buttons
  app.action(DASHBOARD_RESOLVE_BLOCKER, resolveBlockerCallback);
  app.action(DASHBOARD_COMPLETE_PHASE, completePhaseCallback);
  app.action(DASHBOARD_COMPLETE_PLAN, completePlanCallback);
  app.action(DASHBOARD_REFRESH, refreshDashboardCallback);
};

export default { register };
