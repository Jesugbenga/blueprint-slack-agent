export interface SlackSearchMessage {
  text: string;
  userId?: string;
  username?: string;
  channelId?: string;
  channelName?: string;
  ts?: string;
  permalink?: string;
}

/**
 * Search the team's full Slack history using a user token (xoxp-) and the
 * `search.messages` API. This is the "real-time search" path that lets
 * Blueprint find messages in channels it isn't a member of — the bot token
 * can't do this, only a user token with the `search:read` scope can.
 */
export async function searchSlack(
  query: string,
  userToken: string,
  limit = 20,
): Promise<SlackSearchMessage[]> {
  // Imported dynamically so this module can be pulled into workflow steps
  // without bundling Node.js-only dependencies at the top level.
  const { WebClient } = await import("@slack/web-api");
  const client = new WebClient(userToken);
  const res = await client.search.messages({
    query,
    count: limit,
    sort: "timestamp",
    sort_dir: "desc",
  });

  const matches = res.messages?.matches ?? [];
  return matches.map((m) => ({
    text: m.text ?? "",
    userId: m.user,
    username: m.username,
    channelId: m.channel?.id,
    channelName: m.channel?.name,
    ts: m.ts,
    permalink: m.permalink,
  }));
}
