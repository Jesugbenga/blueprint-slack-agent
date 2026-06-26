import type { App } from "@slack/bolt";
import {
  CHANNEL_JOIN_APPROVAL_ACTION,
  SCAFFOLD_APPROVE_ACTION,
  SCAFFOLD_MODIFY_ACTION,
  SCAFFOLD_REJECT_ACTION,
} from "~/lib/slack/blocks";
import { channelJoinApprovalCallback } from "./channel-join-approval";
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
};

export default { register };
