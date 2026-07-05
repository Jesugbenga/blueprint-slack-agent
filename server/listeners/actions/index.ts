import type { App } from "@slack/bolt";
import {
  CHANNEL_JOIN_APPROVAL_ACTION,
  SCAFFOLD_APPROVE_ACTION,
  SCAFFOLD_MODIFY_ACTION,
  SCAFFOLD_REJECT_ACTION,
} from "~/lib/slack/blocks";
import {
  DESIGN_ADD_ACTION,
  DESIGN_APPROVE_ACTION,
  DESIGN_COMPONENT_MENU,
} from "~/lib/slack/design-blocks";
import { channelJoinApprovalCallback } from "./channel-join-approval";
import {
  designAddBlockCallback,
  designApproveCallback,
  designComponentMenuCallback,
} from "./design-action";
import { feedbackButtonsCallback } from "./feedback-button-action";
import sampleActionCallback from "./sample-action";
import { scaffoldReviewCallback } from "./scaffold-review-action";

const register = (app: App) => {
  app.action("sample_action_id", sampleActionCallback);
  app.action("feedback", feedbackButtonsCallback);
  // Channel join approval actions (approve and reject buttons)
  app.action(CHANNEL_JOIN_APPROVAL_ACTION, channelJoinApprovalCallback);
  app.action(
    `${CHANNEL_JOIN_APPROVAL_ACTION}_reject`,
    channelJoinApprovalCallback,
  );
  // Scaffold review actions (approve / modify / reject buttons)
  app.action(SCAFFOLD_APPROVE_ACTION, scaffoldReviewCallback);
  app.action(SCAFFOLD_MODIFY_ACTION, scaffoldReviewCallback);
  app.action(SCAFFOLD_REJECT_ACTION, scaffoldReviewCallback);
  // Collaborative design actions (edit/remove overflow, add block, approve)
  app.action(DESIGN_COMPONENT_MENU, designComponentMenuCallback);
  app.action(DESIGN_ADD_ACTION, designAddBlockCallback);
  app.action(DESIGN_APPROVE_ACTION, designApproveCallback);
};

export default { register };
