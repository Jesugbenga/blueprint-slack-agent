import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { start } from "workflow/api";
import { planWorkflow } from "~/lib/ai/workflows/planWorkflow";
import { isPlanningRequest } from "~/lib/planner";

type AppMentionArgs = SlackEventMiddlewareArgs<"app_mention"> &
  AllMiddlewareArgs;

// Cheap pre-filter: only messages with build-intent language are worth a model
// call. Everything else (greetings, questions, lookups) skips straight to the
// agent, keeping the common @mention path fast.
const BUILD_INTENT =
  /\b(build|create|design|implement|develop|prototype|mock ?up|break ?down|scope out|spin up|add support for|help us (build|ship|create|design))\b/i;

/**
 * Decides whether an @mention is a *planning* request and, if so, starts the
 * Plan-Execute-Verify workflow. Returns true when it handled the mention, so the
 * normal agent (app-mention → chatWorkflow) can bail out.
 *
 * Called from the existing app_mention listener rather than registered
 * separately, so a planning request never gets two responses.
 */
export async function maybeHandlePlanRequest({
  event,
  context,
}: Pick<AppMentionArgs, "event" | "context">): Promise<boolean> {
  const teamId = context.teamId;
  const userId = event.user;
  if (!teamId || !userId) return false;

  // Strip the bot mention(s) so the classifier sees just the request.
  const text = (event.text ?? "").replace(/<@[^>]+>/g, "").trim();
  if (!text) return false;

  // Fast-path: explicit queries are handled by the agent, not the planner.
  if (/^(who\s+knows|context|risks)\b/i.test(text)) return false;

  // Cheap gate before the model: no build-intent language → not a plan request.
  if (!BUILD_INTENT.test(text)) return false;

  const planning = await isPlanningRequest(text).catch(() => false);
  if (!planning) return false;

  const threadTs = event.thread_ts || event.ts;
  await start(planWorkflow, [
    {
      channel: event.channel,
      threadTs,
      userId,
      teamId,
      requestText: text,
    },
  ]);
  console.log(`[Blueprint] Plan workflow started for: ${text.slice(0, 60)}`);
  return true;
}
