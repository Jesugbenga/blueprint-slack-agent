import type {
  AllMiddlewareArgs,
  BlockAction,
  ButtonAction,
  SlackActionMiddlewareArgs,
} from "@slack/bolt";
import { markPhaseComplete, resolveOpenItem, setPlanStatus } from "~/lib/graph";
import {
  type CompletePhaseValue,
  type CompletePlanValue,
  publishHomeDashboard,
  type ResolveBlockerValue,
} from "~/lib/slack/dashboard";

/** Resolve a blocker from the Home dashboard, then refresh the view. */
export const resolveBlockerCallback = async ({
  ack,
  action,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  const button = action as ButtonAction;
  let value: ResolveBlockerValue;
  try {
    value = JSON.parse(button.value);
  } catch {
    logger.error("[dashboard] could not parse resolve-blocker value");
    return;
  }

  const teamId = body.team?.id;
  if (!teamId) return;

  await resolveOpenItem("blocker", value.id, teamId).catch((err) =>
    logger.error("[dashboard] resolve blocker failed:", err),
  );
  await publishHomeDashboard(client, body.user.id, teamId);
};

/** Mark a plan phase complete from the Home dashboard, then refresh the view. */
export const completePhaseCallback = async ({
  ack,
  action,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  const button = action as ButtonAction;
  let value: CompletePhaseValue;
  try {
    value = JSON.parse(button.value);
  } catch {
    logger.error("[dashboard] could not parse complete-phase value");
    return;
  }

  const teamId = body.team?.id;
  if (!teamId) return;

  await markPhaseComplete(value.planId, teamId, value.phaseIndex).catch((err) =>
    logger.error("[dashboard] complete phase failed:", err),
  );
  await publishHomeDashboard(client, body.user.id, teamId);
};

/** Re-render the Home dashboard on demand (the Refresh button). */
export const refreshDashboardCallback = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();
  await publishHomeDashboard(client, body.user.id, body.team?.id);
};

/** Close out a whole plan from the dashboard once all phases are done. */
export const completePlanCallback = async ({
  ack,
  action,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  const button = action as ButtonAction;
  let value: CompletePlanValue;
  try {
    value = JSON.parse(button.value);
  } catch {
    logger.error("[dashboard] could not parse complete-plan value");
    return;
  }

  const teamId = body.team?.id;
  if (!teamId) return;

  await setPlanStatus(value.planId, teamId, "complete").catch((err) =>
    logger.error("[dashboard] complete plan failed:", err),
  );
  await publishHomeDashboard(client, body.user.id, teamId);
};
