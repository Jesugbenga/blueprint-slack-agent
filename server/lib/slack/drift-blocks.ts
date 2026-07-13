import type { KnownBlock } from "@slack/web-api";
import { slackPermalink } from "./utils";

export const DRIFT_NEW_DIRECTION_ACTION = "drift_new_direction";
export const DRIFT_KEEP_ORIGINAL_ACTION = "drift_keep_original";

/** Payload carried on the drift buttons (kept small for Slack's 2000-char limit). */
export interface DriftValue {
  /** Stable id of the past decision being challenged. */
  oldDecisionId: string;
  topic: string;
  approach: string;
  /** Where the past decision was made (for a "keeping original" reference). */
  sourceChannel: string;
  sourceThreadTs: string;
}

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

/**
 * Thread-reply card warning that a new proposal may contradict a prior decision,
 * with buttons to either record a new direction or keep the original.
 */
export function driftBlocks(opts: {
  pastSummary: string;
  pastDate: string;
  value: DriftValue;
}): KnownBlock[] {
  const { pastSummary, pastDate, value } = opts;
  const link = slackPermalink(value.sourceChannel, value.sourceThreadTs);
  const dateText = pastDate ? pastDate.slice(0, 10) : "earlier";
  const btnValue = JSON.stringify({
    ...value,
    approach: truncate(value.approach, 200),
  } satisfies DriftValue);

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "⚠️ Possible decision drift",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          dateText !== "earlier"
            ? `This may *contradict* a decision your team made on *${dateText}*:`
            : "This may *contradict* a decision your team already made:",
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `> ${truncate(pastSummary, 400)}` },
    },
  ];

  if (link) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `📎 <${link}|View the original decision>` },
      ],
    });
  }

  blocks.push(
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "🔄 New direction", emoji: true },
          style: "primary",
          action_id: DRIFT_NEW_DIRECTION_ACTION,
          value: btnValue,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "↩️ Keep original", emoji: true },
          action_id: DRIFT_KEEP_ORIGINAL_ACTION,
          value: btnValue,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "_“New direction” records an updated decision · “Keep original” logs a false positive._",
        },
      ],
    },
  );

  return blocks;
}
