import type {
  AllMiddlewareArgs,
  App,
  BlockAction,
  ButtonAction,
  SlackActionMiddlewareArgs,
} from "@slack/bolt";
import { planDecisionHook } from "~/lib/ai/workflows/hooks";
import {
  PLAN_ADJUST_ACTION,
  PLAN_APPROVE_ACTION,
  PLAN_REASSIGN_ACTION,
  type PlanButtonValue,
} from "~/lib/planner";

/**
 * Resumes the plan workflow's decision hook when the user clicks one of the
 * three plan buttons. Adjust/Reassign then wait for a freeform thread reply,
 * which the message listener routes back into the workflow's modification hook.
 */
export const planDecisionCallback = async ({
  ack,
  action,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  const button = action as ButtonAction;
  let value: PlanButtonValue;
  try {
    value = JSON.parse(button.value);
  } catch {
    logger.error("[plan] could not parse plan button value");
    return;
  }

  const map: Record<string, "approve" | "adjust" | "reassign"> = {
    [PLAN_APPROVE_ACTION]: "approve",
    [PLAN_ADJUST_ACTION]: "adjust",
    [PLAN_REASSIGN_ACTION]: "reassign",
  };
  const decision = map[button.action_id];
  if (!decision) return;

  try {
    await planDecisionHook.resume(value.threadTs, { action: decision });
  } catch (err) {
    logger.error("[plan] failed to resume decision hook:", err);
  }
};

/** Registers plan_approve / plan_adjust / plan_reassign on the app. */
export const planActions = (app: App) => {
  app.action(PLAN_APPROVE_ACTION, planDecisionCallback);
  app.action(PLAN_ADJUST_ACTION, planDecisionCallback);
  app.action(PLAN_REASSIGN_ACTION, planDecisionCallback);
};
