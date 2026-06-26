import type {
  ActionsBlock,
  ContextActionsBlock,
  KnownBlock,
  SectionBlock,
} from "@slack/web-api";
import type { ScaffoldProject } from "~/lib/ai/scaffold";

export const feedbackBlock = ({
  thread_ts,
}: {
  thread_ts: string;
}): ContextActionsBlock => {
  return {
    type: "context_actions",
    elements: [
      {
        type: "feedback_buttons",
        action_id: "feedback",
        positive_button: {
          text: {
            type: "plain_text",
            text: "👍",
          },
          value: `${thread_ts}:positive_feedback`,
        },
        negative_button: {
          text: {
            type: "plain_text",
            text: "👎",
          },
          value: `${thread_ts}:negative_feedback`,
        },
      },
    ],
  };
};

export const CHANNEL_JOIN_APPROVAL_ACTION = "channel_join_approval";

export const channelJoinApprovalBlocks = ({
  toolCallId,
  channelId,
  channelName,
}: {
  toolCallId: string;
  channelId: string;
  channelName?: string;
}): KnownBlock[] => {
  // Use Slack's channel link format to make it clickable
  const channelLink = `<#${channelId}>`;

  const sectionBlock: SectionBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `🔐 *Permission Request*\n\nI'd like to join the channel ${channelLink} to help with your request. Do you approve?`,
    },
  };

  const actionsBlock: ActionsBlock = {
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Approve",
          emoji: true,
        },
        style: "primary",
        action_id: CHANNEL_JOIN_APPROVAL_ACTION,
        value: JSON.stringify({
          toolCallId,
          channelId,
          channelName,
          approved: true,
        }),
      },
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Reject",
          emoji: true,
        },
        style: "danger",
        action_id: `${CHANNEL_JOIN_APPROVAL_ACTION}_reject`,
        value: JSON.stringify({
          toolCallId,
          channelId,
          channelName,
          approved: false,
        }),
      },
    ],
  };

  return [sectionBlock, actionsBlock];
};

// ---------------------------------------------------------------------------
// Scaffold review — engineer Approve / Modify / Reject flow for a generated
// prototype.
// ---------------------------------------------------------------------------

export const SCAFFOLD_APPROVE_ACTION = "scaffold_approve";
export const SCAFFOLD_MODIFY_ACTION = "scaffold_modify";
export const SCAFFOLD_REJECT_ACTION = "scaffold_reject";

/** Payload carried on the scaffold review buttons (kept small for Slack's 2000-char limit). */
export interface ScaffoldReviewValue {
  scaffoldId: string;
  topic: string;
  description: string;
  summary: string;
}

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}…` : s;

export const scaffoldReviewBlocks = ({
  scaffoldId,
  topic,
  description,
  project,
  groundedNote = "",
}: {
  scaffoldId: string;
  topic: string;
  description: string;
  project: ScaffoldProject;
  groundedNote?: string;
}): KnownBlock[] => {
  const fileList = project.files
    .map((f) => `• \`${f.path}\` — ${f.description}`)
    .join("\n");
  const setup =
    project.setup.length > 0
      ? `\n\n*Run it*\n\`\`\`\n${project.setup.join("\n")}\n\`\`\``
      : "";
  const questions =
    project.openQuestions.length > 0
      ? `\n\n*Open questions*\n${project.openQuestions
          .map((q) => `• ${q}`)
          .join("\n")}`
      : "";

  // Slack section text is capped at 3000 chars.
  const detail = truncate(
    `*Files*\n${fileList}${setup}${questions}${groundedNote}`,
    2900,
  );

  const value = JSON.stringify({
    scaffoldId,
    topic,
    description: truncate(description, 1200),
    summary: truncate(project.summary, 200),
  } satisfies ScaffoldReviewValue);

  const headerBlock: SectionBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `🧱 *Prototype ready for review*\n${project.summary}\n*Stack:* ${project.stack}`,
    },
  };

  const detailBlock: SectionBlock = {
    type: "section",
    text: { type: "mrkdwn", text: detail },
  };

  const actionsBlock: ActionsBlock = {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "✅ Approve", emoji: true },
        style: "primary",
        action_id: SCAFFOLD_APPROVE_ACTION,
        value,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "✏️ Modify", emoji: true },
        action_id: SCAFFOLD_MODIFY_ACTION,
        value,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "🗑️ Reject", emoji: true },
        style: "danger",
        action_id: SCAFFOLD_REJECT_ACTION,
        value,
      },
    ],
  };

  return [headerBlock, detailBlock, actionsBlock];
};
