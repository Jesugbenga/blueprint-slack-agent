import { defineHook } from "workflow";
import { z } from "zod";

/**
 * Human-in-the-loop hook for channel join approval.
 *
 * This hook pauses the workflow until a user approves or rejects
 * the agent's request to join a Slack channel.
 */
export const channelJoinApprovalHook = defineHook({
  schema: z.object({
    approved: z.boolean(),
    channelId: z.string(),
    channelName: z.string().optional(),
  }),
});

/**
 * Plan-Execute-Verify approval gate. Resumed by the plan action buttons with
 * the chosen action; the workflow loops on adjust/reassign and exits on approve.
 */
export const planDecisionHook = defineHook({
  schema: z.object({
    action: z.enum(["approve", "adjust", "reassign", "cancel"]),
  }),
});

/**
 * Freeform plan modification. Resumed by the message listener when the user
 * replies in the plan thread after clicking Adjust or Reassign.
 */
export const planModHook = defineHook({
  schema: z.object({
    text: z.string(),
  }),
});
