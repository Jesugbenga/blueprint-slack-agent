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
  const linkText = link ? ` (<${link}|original thread>)` : "";
  const dateText = pastDate ? pastDate.slice(0, 10) : "earlier";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `⚠️ *Heads up* — your team made a related decision on *${dateText}*:\n>${truncate(pastSummary, 400)}${linkText}\n\nHas something changed, or is this a new direction?`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "New direction — update the record",
            emoji: true,
          },
          style: "primary",
          action_id: DRIFT_NEW_DIRECTION_ACTION,
          value: JSON.stringify({
            ...value,
            approach: truncate(value.approach, 200),
          } satisfies DriftValue),
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Never mind, keeping original decision",
            emoji: true,
          },
          action_id: DRIFT_KEEP_ORIGINAL_ACTION,
          value: JSON.stringify({
            ...value,
            approach: truncate(value.approach, 200),
          } satisfies DriftValue),
        },
      ],
    },
  ];
}
