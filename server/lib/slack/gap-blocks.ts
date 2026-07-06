import type { KnownBlock, View } from "@slack/web-api";
import type { GapAnalysis } from "~/lib/gapDetector";

export const GAP_FILL_ACTION = "gap_fill";
export const GAP_SKIP_ACTION = "gap_skip";
export const GAP_FILL_VIEW = "gap_fill_view";

/** Payload carried on the gap buttons — just a pointer to the saved draft. */
export interface GapButtonValue {
  draftId: string;
}

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

/**
 * The proactive gap card: a brief opener, a checklist of missing items each with
 * a "why it matters" note, an optional dependency note, and Fill/Skip buttons.
 */
export function gapBlocks(opts: {
  analysis: GapAnalysis;
  draftId: string;
}): KnownBlock[] {
  const { analysis, draftId } = opts;

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `📝 *Before engineering starts on "${truncate(analysis.title, 120)}", I noticed a few gaps:*`,
      },
    },
  ];

  for (const gap of analysis.gaps) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `• *${gap.label}* — _${gap.why}_`,
      },
    });
  }

  if (analysis.dependencyNote) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `🔗 ${analysis.dependencyNote}` }],
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Fill in the gaps", emoji: true },
        style: "primary",
        action_id: GAP_FILL_ACTION,
        value: JSON.stringify({ draftId } satisfies GapButtonValue),
      },
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Skip — this is exploratory",
          emoji: true,
        },
        action_id: GAP_SKIP_ACTION,
        value: JSON.stringify({ draftId } satisfies GapButtonValue),
      },
    ],
  });

  return blocks;
}

/**
 * A modal with one input per missing gap, pre-populated with Blueprint's
 * inferred suggestion where available.
 */
export function gapFillModal(opts: {
  analysis: GapAnalysis;
  draftId: string;
}): View {
  const { analysis, draftId } = opts;

  const blocks: KnownBlock[] = analysis.gaps.map((gap) => ({
    type: "input",
    block_id: `gap_${gap.key}`,
    optional: true,
    label: { type: "plain_text", text: gap.label },
    element: {
      type: "plain_text_input",
      action_id: "value",
      multiline: gap.key === "acceptanceCriteria",
      initial_value: gap.suggestion || undefined,
      placeholder: { type: "plain_text", text: truncate(gap.why, 140) },
    },
  }));

  return {
    type: "modal",
    callback_id: GAP_FILL_VIEW,
    private_metadata: draftId,
    title: { type: "plain_text", text: "Fill in the gaps" },
    submit: { type: "plain_text", text: "Post spec" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

/** The enriched feature spec posted back to the channel after the modal submits. */
export function featureSpecBlocks(opts: {
  title: string;
  ownerLine: string;
  fields: { label: string; value: string }[];
  dependencyNote: string;
}): KnownBlock[] {
  const { title, fields, dependencyNote } = opts;
  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `📋 ${truncate(title, 140)}`,
        emoji: true,
      },
    },
  ];

  for (const f of fields) {
    if (!f.value.trim()) continue;
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${f.label}:* ${f.value}` },
    });
  }

  if (dependencyNote) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `🔗 ${dependencyNote}` }],
    });
  }

  return blocks;
}
