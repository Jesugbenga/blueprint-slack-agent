import type { KnownBlock } from "@slack/web-api";
import type { HandoffBrief } from "~/lib/ai/handoff";
import type { OpenItem } from "~/lib/graph";
import { slackPermalink } from "./utils";

export const HANDOFF_PICKUP_ACTION = "handoff_pickup";

/** Small payload carried on a "Pick this up" button (kept under Slack's 2000-char limit). */
export interface HandoffPickupValue {
  kind: OpenItem["kind"];
  id: string;
  summary: string;
}

const KIND_EMOJI: Record<OpenItem["kind"], string> = {
  blocker: "⛔",
  question: "❓",
  decision: "📌",
};

const KIND_LABEL: Record<OpenItem["kind"], string> = {
  blocker: "Blocker",
  question: "Open question",
  decision: "Decision follow-up",
};

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

/**
 * End-of-day handoff card: a header, one section per open item with a
 * "Pick this up" button, and a footer showing who's been tagged to cover.
 */
export function handoffBlocks(opts: {
  personName: string;
  brief: HandoffBrief;
  items: OpenItem[];
  taggedPersonId?: string;
  taggedTimezone?: string;
}): KnownBlock[] {
  const { personName, brief, items, taggedPersonId, taggedTimezone } = opts;

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🌙 End-of-day handoff — ${truncate(personName, 60)}`,
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*${items.length}* open item${items.length === 1 ? "" : "s"} to hand off before ${personName} signs off.`,
        },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: brief.intro },
    },
    { type: "divider" },
  ];

  items.forEach((item, i) => {
    const note = brief.notes[i] ? `\n_${brief.notes[i]}_` : "";
    const link = slackPermalink(item.channel, item.threadTs);
    const linkSuffix = link ? `  <${link}|↗ thread>` : "";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${KIND_EMOJI[item.kind]}  *${KIND_LABEL[item.kind]}*\n${truncate(item.summary, 280)}${linkSuffix}${note}`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "🙌 Pick this up", emoji: true },
        style: "primary",
        action_id: HANDOFF_PICKUP_ACTION,
        value: JSON.stringify({
          kind: item.kind,
          id: item.id,
          summary: truncate(item.summary, 140),
        } satisfies HandoffPickupValue),
      },
    });
  });

  const footerText = taggedPersonId
    ? `🤝 Tagging <@${taggedPersonId}>${taggedTimezone ? ` · ${taggedTimezone}` : ""} to cover while ${personName} is offline.`
    : `⏳ No compatible teammate is online right now — this will wait for the next available person.`;

  blocks.push(
    { type: "divider" },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: footerText }],
    },
  );

  return blocks;
}
