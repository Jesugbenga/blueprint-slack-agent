import { sleep } from "workflow";

export interface HandoffWorkflowInput {
  personId: string;
  personName: string;
  teamId: string;
}

/**
 * Per-user durable workflow that fires an end-of-day handoff at 5:30pm in the
 * user's local timezone, then re-queues itself for the next day. Started once
 * per user (idempotently) from the message classifier.
 */
export async function endOfDayHandoffWorkflow(input: HandoffWorkflowInput) {
  "use workflow";
  // DEMO: fire the handoff once, then stop. For production, wrap this in
  // `for (;;) { ... }` so it re-queues each day at the user's local 5:30pm.
  const delayMs = await computeHandoffDelay(input);
  await sleep(delayMs);
  await runHandoff(input);
}

/** How long until this user's next local workday-end. */
async function computeHandoffDelay(
  input: HandoffWorkflowInput,
): Promise<number> {
  "use step";
  const { WebClient } = await import("@slack/web-api");
  const { resolvePersonTimezone, msUntilLocalMinuteOfDay, WORKDAY_END_MIN } =
    await import("~/lib/timezone");
  const client = new WebClient(process.env.SLACK_BOT_TOKEN as string);
  const tz = await resolvePersonTimezone(
    client,
    input.personId,
    input.teamId,
    input.personName,
  );
  const offset = tz?.tzOffset ?? 0;
  const endMin = tz?.workdayEnd ?? WORKDAY_END_MIN;
  const realDelay = msUntilLocalMinuteOfDay(offset, endMin);
  // DEMO: cap the wait to 10 minutes so the handoff fires during demos.
  // Restore to `return realDelay;` for production (fires at local 5:30pm).
  return Math.min(realDelay, 10 * 60_000);
}

/** Build and post the handoff brief, tagging a compatible online teammate. */
async function runHandoff(input: HandoffWorkflowInput): Promise<void> {
  "use step";
  const { WebClient } = await import("@slack/web-api");
  const { getCoverCandidates, getMostActiveChannels, getOpenItemsForPerson } =
    await import("~/lib/graph");
  const { isWithinWorkday } = await import("~/lib/timezone");
  const { generateHandoffBrief } = await import("~/lib/ai/handoff");
  const { handoffBlocks } = await import("~/lib/slack/handoff-blocks");
  const client = new WebClient(process.env.SLACK_BOT_TOKEN as string);

  const items = await getOpenItemsForPerson(input.personId, input.teamId).catch(
    () => [],
  );
  if (items.length === 0) return;

  const sinceIso = new Date(Date.now() - 16 * 60 * 60 * 1000).toISOString();
  const activeChannels = await getMostActiveChannels(
    input.personId,
    input.teamId,
    sinceIso,
  ).catch(() => []);
  const channels =
    activeChannels.length > 0
      ? activeChannels
      : [...new Set(items.map((i) => i.channel).filter(Boolean))];
  if (channels.length === 0) return;

  const brief = await generateHandoffBrief(input.personName, items);

  // Tag the highest-activity teammate who is currently inside their workday.
  const candidates = await getCoverCandidates(
    input.teamId,
    input.personId,
  ).catch(() => []);
  const cover = candidates.find((c) =>
    isWithinWorkday({
      timezone: c.timezone,
      tzOffset: c.tzOffset,
      workdayEnd: c.workdayEnd,
    }),
  );

  const blocks = handoffBlocks({
    personName: input.personName,
    brief,
    items,
    taggedPersonId: cover?.personId,
    taggedTimezone: cover?.timezone,
  });

  for (const channel of channels) {
    try {
      await client.chat.postMessage({
        channel,
        blocks,
        text: `End-of-day handoff for ${input.personName}`,
      });
    } catch (err) {
      console.error(`[handoff] failed to post to ${channel}:`, err);
    }
  }
}
