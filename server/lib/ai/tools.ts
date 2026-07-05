import { tool } from "ai";
import { z } from "zod";
import type { SlackAgentContextInput } from "~/lib/ai/context";
import { channelJoinApprovalHook } from "~/lib/ai/workflows/hooks";

const getChannelMessages = tool({
  description:
    "Get the messages from a Slack channel. Use this to understand the context of a channel conversation. Pass the channel_id of the channel you want to read.",
  inputSchema: z.object({
    channel_id: z
      .string()
      .describe(
        "The Slack channel ID to fetch messages from (e.g., C0A2NKEHLLV)",
      ),
  }),
  execute: async ({ channel_id }, { experimental_context }) => {
    "use step";
    // Dynamic imports inside step to avoid bundling Node.js modules in workflow
    const { WebClient } = await import("@slack/web-api");
    const { getChannelContextAsModelMessage } = await import(
      "~/lib/slack/utils"
    );

    const ctx = experimental_context as SlackAgentContextInput;
    const client = new WebClient(ctx.token);
    try {
      const messages = await getChannelContextAsModelMessage({
        channel: channel_id,
        botId: ctx.bot_id,
        client,
      });
      return {
        success: true,
        messages,
      };
    } catch (error) {
      console.error("Failed to get channel messages:", error);
      return {
        success: false,
        message: "Failed to get channel messages",
        error: error instanceof Error ? error.message : "Unknown error",
        messages: [],
      };
    }
  },
});

const getThreadMessages = tool({
  description:
    "Get the messages from the current conversation thread. This retrieves the conversation history between you and the user.",
  inputSchema: z.object({
    dm_channel: z
      .string()
      .describe("The DM channel ID where this thread lives"),
    thread_ts: z.string().describe("The thread timestamp"),
  }),
  execute: async ({ dm_channel, thread_ts }, { experimental_context }) => {
    "use step";
    const { WebClient } = await import("@slack/web-api");
    const { getThreadContextAsModelMessage } = await import(
      "~/lib/slack/utils"
    );

    const ctx = experimental_context as SlackAgentContextInput;
    const client = new WebClient(ctx.token);
    try {
      const messages = await getThreadContextAsModelMessage({
        channel: dm_channel,
        ts: thread_ts,
        botId: ctx.bot_id,
        client,
      });
      return {
        success: true,
        messages,
      };
    } catch (error) {
      console.error("Failed to get thread messages:", error);
      return {
        success: false,
        message: "Failed to get thread messages",
        error: error instanceof Error ? error.message : "Unknown error",
        messages: [],
      };
    }
  },
});

// Helper step function to check channel and send approval request
async function sendApprovalRequest(
  ctx: SlackAgentContextInput,
  channelId: string,
  toolCallId: string,
): Promise<
  | { success: true; channelName?: string }
  | { success: false; message: string; isPrivate?: boolean }
> {
  "use step";
  const { WebClient } = await import("@slack/web-api");
  const { channelJoinApprovalBlocks } = await import("~/lib/slack/blocks");

  const client = new WebClient(ctx.token);

  // Get channel info to get friendly name
  let channelName: string | undefined;

  try {
    const channelInfo = await client.conversations.info({
      channel: channelId,
    });
    channelName = channelInfo.channel?.name;
  } catch (infoError) {
    // If we get "channel_not_found", it's likely a private channel we can't access
    // (bots can't see private channels they're not members of)
    const errorMessage = infoError instanceof Error ? infoError.message : "";
    if (
      errorMessage.includes("channel_not_found") ||
      errorMessage.includes("missing_scope")
    ) {
      return {
        success: false,
        message:
          "I cannot access this channel. It may be a private channel. I can only join public channels since I don't have a user token.",
        isPrivate: true,
      };
    }
    // For other errors, continue without name
  }

  // Send approval request as a reply in the current thread (not top-level)
  await client.chat.postMessage({
    channel: ctx.dm_channel,
    thread_ts: ctx.thread_ts,
    blocks: channelJoinApprovalBlocks({
      toolCallId,
      channelId: channelId,
      channelName,
    }),
    text: `Permission request: Join channel <#${channelId}>?`,
  });

  return { success: true, channelName };
}

// Helper step function to actually join the channel
async function performChannelJoin(
  ctx: SlackAgentContextInput,
  channelId: string,
): Promise<{
  success: boolean;
  message: string;
  channel?: unknown;
  error?: string;
}> {
  "use step";
  const { WebClient } = await import("@slack/web-api");
  const client = new WebClient(ctx.token);

  try {
    const result = await client.conversations.join({
      channel: channelId,
    });

    if (result.ok) {
      return {
        success: true,
        message: `Successfully joined channel <#${channelId}>`,
        channel: result.channel,
      };
    }

    return {
      success: false,
      message: "Failed to join channel after approval",
      error: result.error,
    };
  } catch (error) {
    console.error("Failed to join channel:", error);
    return {
      success: false,
      message: "Failed to join channel",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

const joinChannel = tool({
  description:
    "Join a public Slack channel. Use this when you need to access a channel's messages but aren't a member yet. Only works for public channels. This will request approval from the user before joining.",
  inputSchema: z.object({
    channel_id: z
      .string()
      .describe("The Slack channel ID to join (e.g., C0A2NKEHLLV)"),
  }),
  execute: async ({ channel_id }, { toolCallId, experimental_context }) => {
    // Tool execute runs in workflow context - hooks must be created here, not in steps
    const ctx = experimental_context as SlackAgentContextInput;

    try {
      // Step 1: Check channel and send approval request (runs in step context)
      const approvalResult = await sendApprovalRequest(
        ctx,
        channel_id,
        toolCallId,
      );

      if (!approvalResult.success) {
        return approvalResult;
      }

      // Step 2: Create hook and wait for approval (runs in workflow context)
      const hook = channelJoinApprovalHook.create({ token: toolCallId });
      const { approved, channelId } = await hook;

      if (!approved) {
        return {
          success: false,
          message: `User declined to join channel <#${channelId}>`,
          rejected: true,
        };
      }

      // Step 3: Actually join the channel (runs in step context)
      return await performChannelJoin(ctx, channelId);
    } catch (error) {
      console.error("Failed to join channel:", error);
      return {
        success: false,
        message: "Failed to join channel",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
});

const searchChannels = tool({
  description:
    "Search for Slack channels by name or topic. Use this when the user asks about a channel by name (e.g., 'tell me about the marketing channel') or wants to find channels matching certain criteria. Returns channel details including name, purpose, topic, and member count.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "The search query to find channels (e.g., 'marketing', 'engineering', 'announcements')",
      ),
    team_id: z.string().describe("The workspace team ID to search channels in"),
  }),
  execute: async ({ query, team_id }, { experimental_context }) => {
    "use step";
    const { WebClient } = await import("@slack/web-api");

    const ctx = experimental_context as SlackAgentContextInput;
    const client = new WebClient(ctx.token);
    try {
      const normalizedQuery = query.toLowerCase().replace(/^#/, "");

      // Fetch all public channels (paginated)
      const allChannels: Array<{
        id: string;
        name: string;
        purpose?: { value?: string };
        topic?: { value?: string };
        num_members?: number;
        is_archived?: boolean;
        is_private?: boolean;
      }> = [];

      let cursor: string | undefined;
      do {
        const result = await client.conversations.list({
          team_id,
          types: "public_channel",
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        if (result.channels) {
          allChannels.push(
            ...result.channels.filter(
              (ch): ch is (typeof allChannels)[number] => !!ch.id && !!ch.name,
            ),
          );
        }

        cursor = result.response_metadata?.next_cursor;
      } while (cursor);

      // Filter channels matching the query
      const matchingChannels = allChannels.filter((channel) => {
        const name = channel.name?.toLowerCase() || "";
        const purpose = channel.purpose?.value?.toLowerCase() || "";
        const topic = channel.topic?.value?.toLowerCase() || "";

        return (
          name.includes(normalizedQuery) ||
          purpose.includes(normalizedQuery) ||
          topic.includes(normalizedQuery)
        );
      });

      if (matchingChannels.length === 0) {
        return {
          success: true,
          message: `No channels found matching "${query}"`,
          channels: [],
        };
      }

      // Sort by relevance (exact name match first, then by member count)
      const sortedChannels = matchingChannels.sort((a, b) => {
        const aExactMatch = a.name?.toLowerCase() === normalizedQuery;
        const bExactMatch = b.name?.toLowerCase() === normalizedQuery;
        if (aExactMatch && !bExactMatch) return -1;
        if (!aExactMatch && bExactMatch) return 1;
        return (b.num_members || 0) - (a.num_members || 0);
      });

      // Return top 10 most relevant channels
      const topChannels = sortedChannels.slice(0, 10).map((channel) => ({
        id: channel.id,
        name: channel.name,
        purpose: channel.purpose?.value || null,
        topic: channel.topic?.value || null,
        member_count: channel.num_members || 0,
      }));

      return {
        success: true,
        message: `Found ${matchingChannels.length} channel(s) matching "${query}"`,
        channels: topChannels,
      };
    } catch (error) {
      console.error("Failed to search channels:", error);
      return {
        success: false,
        message: "Failed to search channels",
        error: error instanceof Error ? error.message : "Unknown error",
        channels: [],
      };
    }
  },
});

const queryDecisions = tool({
  description:
    "Look up decisions the team has already made about a topic from Blueprint's long-term memory. Use this to answer 'why did we...', 'what did we decide about...', or 'did we already choose...' questions. Returns each decision with who made it and a Slack permalink to the original thread so you can cite your sources.",
  inputSchema: z.object({
    topic: z
      .string()
      .describe(
        "The topic to look up, e.g. 'auth_service', 'checkout flow', 'database migration'. Free text is fine; it is normalized automatically.",
      ),
  }),
  execute: async ({ topic }, { experimental_context }) => {
    "use step";
    const { queryDecisions: query } = await import("~/lib/graph");
    const { slackPermalink } = await import("~/lib/slack/utils");
    const ctx = experimental_context as SlackAgentContextInput;
    try {
      const decisions = await query(topic, ctx.team_id);
      return {
        success: true,
        count: decisions.length,
        decisions: decisions.map((d) => ({
          summary: d.summary,
          decidedBy: d.personName,
          decidedById: d.personId,
          date: d.date,
          source: slackPermalink(d.channel, d.threadTs),
        })),
      };
    } catch (error) {
      console.error("Failed to query decisions:", error);
      return {
        success: false,
        message: "Failed to query decisions from memory",
        error: error instanceof Error ? error.message : "Unknown error",
        decisions: [],
      };
    }
  },
});

const queryBlockers = tool({
  description:
    "Look up blockers and concerns the team has raised about a topic from Blueprint's long-term memory. Use this to answer 'what's blocking...', 'what concerns were raised about...', or 'why didn't we...' questions. Returns each blocker with who raised it and a Slack permalink to the original thread.",
  inputSchema: z.object({
    topic: z
      .string()
      .describe(
        "The topic to look up, e.g. 'auth_service', 'checkout flow'. Free text is fine; it is normalized automatically.",
      ),
  }),
  execute: async ({ topic }, { experimental_context }) => {
    "use step";
    const { queryBlockers: query } = await import("~/lib/graph");
    const { slackPermalink } = await import("~/lib/slack/utils");
    const ctx = experimental_context as SlackAgentContextInput;
    try {
      const blockers = await query(topic, ctx.team_id);
      return {
        success: true,
        count: blockers.length,
        blockers: blockers.map((b) => ({
          summary: b.summary,
          raisedBy: b.personName,
          raisedById: b.personId,
          date: b.date,
          source: slackPermalink(b.channel, b.threadTs),
        })),
      };
    } catch (error) {
      console.error("Failed to query blockers:", error);
      return {
        success: false,
        message: "Failed to query blockers from memory",
        error: error instanceof Error ? error.message : "Unknown error",
        blockers: [],
      };
    }
  },
});

const whoKnows = tool({
  description:
    "Find out who on the team has the most context on a topic, based on how often they've discussed it. Use this to answer 'who knows about...', 'who should I ask about...', or 'who owns...' questions. Returns people ranked by involvement so you can tag them with <@user_id>.",
  inputSchema: z.object({
    topic: z
      .string()
      .describe(
        "The topic to look up, e.g. 'auth_service', 'checkout flow'. Free text is fine; it is normalized automatically.",
      ),
  }),
  execute: async ({ topic }, { experimental_context }) => {
    "use step";
    const { whoKnows: query } = await import("~/lib/graph");
    const ctx = experimental_context as SlackAgentContextInput;
    try {
      const experts = await query(topic, ctx.team_id);
      return {
        success: true,
        count: experts.length,
        experts: experts.map((e) => ({
          name: e.personName,
          userId: e.personId,
          timesDiscussed: e.count,
        })),
      };
    } catch (error) {
      console.error("Failed to query experts:", error);
      return {
        success: false,
        message: "Failed to query experts from memory",
        error: error instanceof Error ? error.message : "Unknown error",
        experts: [],
      };
    }
  },
});

const searchHistory = tool({
  description:
    "Search the team's entire Slack history (including channels you aren't a member of) for messages matching a query. Use this for broad recall like 'has anyone discussed X', 'where did we talk about Y', or to find the original thread behind a decision. Returns messages with permalinks you can cite as <permalink|source>. Prefer queryDecisions/queryBlockers/whoKnows first for structured memory; use this when those return nothing or for raw message lookup.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "Search text. Slack search operators work too, e.g. 'in:#eng auth', 'from:@alice', 'rate limit'.",
      ),
  }),
  execute: async ({ query }) => {
    "use step";
    const userToken = process.env.SLACK_USER_TOKEN;
    if (!userToken) {
      return {
        success: false,
        message:
          "Full-history search is unavailable — SLACK_USER_TOKEN is not configured.",
        results: [],
      };
    }
    const { searchSlack } = await import("~/lib/slack/search");
    try {
      const results = await searchSlack(query, userToken);
      return {
        success: true,
        count: results.length,
        results: results.map((r) => ({
          text: r.text,
          author: r.username,
          channel: r.channelName,
          permalink: r.permalink,
        })),
      };
    } catch (error) {
      console.error("Failed to search Slack history:", error);
      return {
        success: false,
        message: "Failed to search Slack history",
        error: error instanceof Error ? error.message : "Unknown error",
        results: [],
      };
    }
  },
});

const scaffold = tool({
  description:
    "Generate a runnable prototype (database schema + API + supporting files) from a plain-English feature description, grounded in the team's past decisions and blockers. Posts an interactive review card (Approve / Modify / Reject) plus the code files into the conversation. Use this when the user asks to 'build', 'scaffold', 'prototype', 'mock up', or 'generate code for' a feature.",
  inputSchema: z.object({
    description: z
      .string()
      .describe(
        "The feature to prototype, in plain English, e.g. 'a webhook endpoint that syncs Stripe payments to our orders table'.",
      ),
    topic: z
      .string()
      .optional()
      .describe(
        "Optional short topic label to ground the scaffold in related memory, e.g. 'checkout_flow', 'auth_service'. Free text is fine.",
      ),
  }),
  execute: async ({ description, topic }, { experimental_context }) => {
    "use step";
    const ctx = experimental_context as SlackAgentContextInput;
    const { randomUUID } = await import("node:crypto");
    const { WebClient } = await import("@slack/web-api");
    const { generateScaffold } = await import("~/lib/ai/scaffold");
    const { deliverScaffold } = await import("~/lib/slack/scaffold-message");
    try {
      const { project, groundingDecisions, groundingBlockers } =
        await generateScaffold(description, ctx.team_id, topic);

      const grounded =
        groundingDecisions.length + groundingBlockers.length > 0
          ? `\n\n_Grounded in ${groundingDecisions.length} prior decision(s) and ${groundingBlockers.length} known blocker(s) from team memory._`
          : "";

      const client = new WebClient(ctx.token);
      const channelId = ctx.dm_channel;
      // Keep the card in the same thread the user is talking in.
      const post = async (m: { text: string; blocks?: unknown[] }) =>
        client.chat.postMessage({
          channel: channelId,
          thread_ts: ctx.thread_ts,
          text: m.text,
          // biome-ignore lint/suspicious/noExplicitAny: Slack block typing crosses the dynamic-import boundary
          blocks: m.blocks as any,
        });

      await deliverScaffold({
        project,
        scaffoldId: randomUUID(),
        topic: topic ?? description,
        description,
        groundedNote: grounded,
        post,
        client,
        channelId,
      });

      return {
        success: true,
        summary: project.summary,
        stack: project.stack,
        fileCount: project.files.length,
        message:
          "Posted a prototype review card (Approve / Modify / Reject) with the generated files into the thread.",
      };
    } catch (error) {
      console.error("Failed to generate scaffold:", error);
      return {
        success: false,
        message: "Failed to generate the prototype",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
});

const designUI = tool({
  description:
    "Turn a plain-English feature request into an INTERACTIVE UI MOCKUP rendered as Slack Block Kit directly in the thread — a real product screen (header, form fields, activity lists, buttons), not code or documentation. The whole team can then edit, add, or remove components and approve the design. Use this whenever a PM asks to 'design', 'mock up', 'build a UI/page/screen', 'wireframe', or 'prototype the interface' for a feature.",
  inputSchema: z.object({
    description: z
      .string()
      .describe(
        "The feature to design, in plain English, e.g. 'a user profile page that shows activity history and lets users update their email'.",
      ),
    topic: z
      .string()
      .optional()
      .describe(
        "Optional short topic label to ground the design in team memory, e.g. 'user_profile'.",
      ),
  }),
  execute: async ({ description, topic }, { experimental_context }) => {
    "use step";
    const ctx = experimental_context as SlackAgentContextInput;
    const { randomUUID } = await import("node:crypto");
    const { WebClient } = await import("@slack/web-api");
    const { generateDesign } = await import("~/lib/ai/design");
    const { renderDesignBlocks } = await import("~/lib/slack/design-blocks");
    const { saveDesign, recordDesignEdit } = await import("~/lib/graph");
    try {
      const design = await generateDesign(description, ctx.team_id, topic);
      const designId = randomUUID();
      const authorId = ctx.user_id ?? "unknown";
      const client = new WebClient(ctx.token);
      const channel = ctx.dm_channel;

      // Step 1 — post the enriched context summary.
      const expertLine =
        design.experts.length > 0
          ? design.experts
              .slice(0, 3)
              .map((e) => `<@${e.personId}>`)
              .join(", ")
          : "none on record yet";
      const decisionLine =
        design.groundingDecisions.length > 0
          ? design.groundingDecisions
              .slice(0, 3)
              .map((d) => `• ${d.summary}`)
              .join("\n")
          : "• none found";
      await client.chat.postMessage({
        channel,
        thread_ts: ctx.thread_ts,
        text: `Designing: ${design.title}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*🧠 Enriched context for:* _${description}_\n\n*Relevant past decisions*\n${decisionLine}\n\n*Suggested experts:* ${expertLine}`,
            },
          },
        ],
      });

      // Persist the initial design state before rendering.
      await saveDesign({
        designId,
        teamId: ctx.team_id,
        channel,
        threadTs: ctx.thread_ts,
        title: design.title,
        topic: design.topic,
        description,
        status: "draft",
        spec: JSON.stringify(design.spec),
        enrichment: JSON.stringify(design.enrichment),
        authorId,
        authorName: "PM",
      });
      await recordDesignEdit({
        designId,
        teamId: ctx.team_id,
        action: "create",
        detail: `Created design "${design.title}" from: ${description}`,
        byId: authorId,
        byName: "PM",
      });

      // Step 2 — post the interactive Block Kit design.
      await client.chat.postMessage({
        channel,
        thread_ts: ctx.thread_ts,
        text: `Design: ${design.title}`,
        blocks: renderDesignBlocks({
          designId,
          title: design.title,
          spec: design.spec,
          status: "draft",
          enrichment: design.enrichment,
        }),
        metadata: {
          event_type: "blueprint_design",
          event_payload: { designId },
        },
      });

      return {
        success: true,
        title: design.title,
        componentCount: design.spec.length,
        message:
          "Posted an enriched context summary and an interactive Block Kit design. The team can edit, add, remove components, and approve it in the thread.",
      };
    } catch (error) {
      console.error("Failed to generate design:", error);
      return {
        success: false,
        message: "Failed to generate the UI design",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
});

export const slackTools = {
  getChannelMessages,
  getThreadMessages,
  joinChannel,
  searchChannels,
  queryDecisions,
  queryBlockers,
  whoKnows,
  searchHistory,
  scaffold,
  designUI,
};
