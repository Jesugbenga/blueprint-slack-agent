import type {
  AllMiddlewareArgs,
  App,
  BlockAction,
  ButtonAction,
  SlackActionMiddlewareArgs,
} from "@slack/bolt";
import type { KnownBlock } from "@slack/web-api";
import { planDecisionHook } from "~/lib/ai/workflows/hooks";
import {
  PLAN_ADJUST_ACTION,
  PLAN_APPROVE_ACTION,
  PLAN_CANCEL_ACTION,
  PLAN_REASSIGN_ACTION,
  type PlanButtonValue,
} from "~/lib/planner";

/** A resolved/consumed hook throws this — a stale or duplicate button click. */
function isHookNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  const msg = err instanceof Error ? err.message : String(err);
  return name === "HookNotFoundError" || /hook not found/i.test(msg);
}

const STATUS_LABEL: Record<
  "approve" | "adjust" | "reassign" | "cancel",
  string
> = {
  approve: "▶️ Starting — plan locked.",
  adjust: "✏️ Adjusting — reply in the thread with the change.",
  reassign: "🔀 Reassigning — reply in the thread with the phase and owner.",
  cancel: "🛑 Plan cancelled.",
};

/**
 * Replace the clicked plan message's buttons with a status line so it can't be
 * clicked again (prevents resuming an already-consumed hook). Best-effort.
 */
async function retirePlanButtons(
  client: AllMiddlewareArgs["client"],
  channel: string | undefined,
  ts: string | undefined,
  blocks: unknown,
  statusText: string,
): Promise<void> {
  if (!channel || !ts) return;
  const kept = Array.isArray(blocks)
    ? (blocks as KnownBlock[]).filter((b) => b.type !== "actions")
    : [];
  await client.chat
    .update({
      channel,
      ts,
      text: statusText,
      blocks: [
        ...kept,
        { type: "context", elements: [{ type: "mrkdwn", text: statusText }] },
      ],
    })
    .catch(() => {
      /* message may be too old to edit — non-fatal */
    });
}

/**
 * Resumes the plan workflow's decision hook when the user clicks one of the
 * three plan buttons. Adjust/Reassign then wait for a freeform thread reply,
 * which the message listener routes back into the workflow's modification hook.
 * The clicked message's buttons are retired on click so the same decision can't
 * be submitted twice (which would resume an already-consumed hook).
 */
export const planDecisionCallback = async ({
  ack,
  action,
  body,
  client,
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

  const map: Record<string, "approve" | "adjust" | "reassign" | "cancel"> = {
    [PLAN_APPROVE_ACTION]: "approve",
    [PLAN_ADJUST_ACTION]: "adjust",
    [PLAN_REASSIGN_ACTION]: "reassign",
    [PLAN_CANCEL_ACTION]: "cancel",
  };
  const decision = map[button.action_id];
  if (!decision) return;

  const channel = body.channel?.id;
  const ts = body.message?.ts;
  const blocks = body.message?.blocks;

  try {
    await planDecisionHook.resume(value.threadTs, { action: decision });
    // Only a terminal decision retires the card's buttons so it can't be
    // re-clicked. Adjust/Reassign loop back and post an updated plan, so their
    // buttons stay live until the plan is approved or cancelled.
    if (decision === "approve" || decision === "cancel") {
      await retirePlanButtons(
        client,
        channel,
        ts,
        blocks,
        STATUS_LABEL[decision],
      );
    }
  } catch (err) {
    if (isHookNotFound(err)) {
      // The plan step was already actioned (e.g. this is a stale message or a
      // double click). Retire the buttons and move on quietly — not an error.
      logger.info(
        "[plan] decision hook already resolved; ignoring stale click",
      );
      await retirePlanButtons(
        client,
        channel,
        ts,
        blocks,
        "✅ This plan step was already handled.",
      );
      return;
    }
    logger.error("[plan] failed to resume decision hook:", err);
  }
};

/** Registers plan_approve / plan_adjust / plan_reassign / plan_cancel on the app. */
export const planActions = (app: App) => {
  app.action(PLAN_APPROVE_ACTION, planDecisionCallback);
  app.action(PLAN_ADJUST_ACTION, planDecisionCallback);
  app.action(PLAN_REASSIGN_ACTION, planDecisionCallback);
  app.action(PLAN_CANCEL_ACTION, planDecisionCallback);
};
