import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { classifyMessage } from "../../lib/classifier";
import {
  getKnownTopics,
  recordDiscussion,
  storeBlocker,
  storeDecision,
} from "../../lib/graph";

type MessageArgs = SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs;

export async function messageClassifier({
  event,
  client,
  context,
}: MessageArgs) {
  // Slack re-delivers an event (up to 3x) if we don't ack within ~3s. Skip
  // those retries so we don't classify the same message multiple times.
  if (context.retryNum) return;

  // Ignore bot messages, edits, deletions, and empty messages
  if ("subtype" in event && event.subtype) return;
  if ("bot_id" in event && event.bot_id) return;
  if (!("text" in event) || !event.text?.trim()) return;

  // Only classify real channel conversation. Direct messages and group DMs are
  // assistant chats already handled by the agent — classifying them here would
  // fire a second, redundant Gemini call per message (a major source of 429s).
  if (
    "channel_type" in event &&
    (event.channel_type === "im" || event.channel_type === "mpim")
  ) {
    return;
  }

  const userId = "user" in event ? event.user : null;
  if (!userId) return;

  // Fetch the real name from Slack — non-fatal if it fails
  let userName = "Unknown";
  try {
    const info = await client.users.info({ user: userId });
    userName = info.user?.real_name || info.user?.name || "Unknown";
  } catch {
    // continue with fallback
  }

  const channel = event.channel;
  const threadTs =
    "thread_ts" in event && event.thread_ts ? event.thread_ts : event.ts;

  // Classify the message, reusing existing topic labels to avoid graph fragmentation
  const knownTopics = await getKnownTopics().catch(() => []);
  const classified = await classifyMessage(event.text, knownTopics);

  // Nothing interesting — skip
  if (classified.type === "none" || !classified.topic || !classified.summary) {
    return;
  }

  // Always record topic discussion — this builds the expertise graph over time
  await recordDiscussion(userId, userName, classified.topic);

  // Store structured data based on classification
  if (classified.type === "decision") {
    await storeDecision({
      personId: userId,
      personName: userName,
      topic: classified.topic,
      summary: classified.summary,
      channel,
      threadTs,
    });
    console.log(`[Blueprint] Decision stored — topic: ${classified.topic}`);
  } else if (classified.type === "blocker") {
    await storeBlocker({
      personId: userId,
      personName: userName,
      topic: classified.topic,
      summary: classified.summary,
      channel,
      threadTs,
    });
    console.log(`[Blueprint] Blocker stored — topic: ${classified.topic}`);
  }
}
