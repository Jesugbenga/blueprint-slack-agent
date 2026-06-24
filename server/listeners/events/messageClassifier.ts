import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { classifyMessage } from "../../lib/classifier";
import { storeDecision, storeBlocker, recordDiscussion } from "../../lib/graph";

type MessageArgs = SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs;

export async function messageClassifier({ event, client }: MessageArgs) {
  // Ignore bot messages, edits, deletions, and empty messages
  if ("subtype" in event && event.subtype) return;
  if ("bot_id" in event && event.bot_id) return;
  if (!("text" in event) || !event.text?.trim()) return;

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

  // Classify the message
  const classified = await classifyMessage(event.text);

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