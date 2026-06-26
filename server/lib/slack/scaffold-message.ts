import type { KnownBlock, WebClient } from "@slack/web-api";
import type { ScaffoldProject } from "~/lib/ai/scaffold";
import { scaffoldReviewBlocks } from "./blocks";

/** Abstraction over how a message is posted (response_url vs chat.postMessage). */
export type ScaffoldPoster = (msg: {
  text: string;
  blocks?: KnownBlock[];
}) => Promise<unknown>;

const MAX_INLINE_CHARS = 3500;

const basename = (filePath: string): string =>
  filePath.split("/").pop() || filePath;

/** Try to upload each generated file as a downloadable Slack snippet. */
async function uploadFiles(
  project: ScaffoldProject,
  client: WebClient,
  channelId: string,
): Promise<boolean> {
  try {
    for (const file of project.files) {
      await client.files.uploadV2({
        channel_id: channelId,
        filename: basename(file.path),
        title: file.path,
        content: file.content,
      });
    }
    return true;
  } catch {
    // Missing files:write scope, not_in_channel, etc. — fall back to inline.
    return false;
  }
}

/** Fallback: post files as inline code blocks, batched to fit Slack limits. */
async function postInline(
  project: ScaffoldProject,
  post: ScaffoldPoster,
): Promise<void> {
  let batch = "";
  const flush = async () => {
    if (!batch) return;
    await post({ text: batch });
    batch = "";
  };
  for (const file of project.files) {
    const content =
      file.content.length > MAX_INLINE_CHARS
        ? `${file.content.slice(
            0,
            MAX_INLINE_CHARS,
          )}\n… (truncated — reinstall Blueprint with files:write for full downloads)`
        : file.content;
    const block = `*${file.path}* — ${file.description}\n\`\`\`\n${content}\n\`\`\`\n`;
    if (batch.length + block.length > MAX_INLINE_CHARS) await flush();
    batch += block;
  }
  await flush();
}

/**
 * Post a generated prototype to Slack: a Block Kit review card (Approve /
 * Modify / Reject) followed by the actual code files as downloadable snippets,
 * with an inline-code-block fallback when uploads aren't possible.
 */
export async function deliverScaffold(opts: {
  project: ScaffoldProject;
  scaffoldId: string;
  topic: string;
  description: string;
  groundedNote?: string;
  post: ScaffoldPoster;
  client?: WebClient;
  channelId?: string;
}): Promise<void> {
  const {
    project,
    scaffoldId,
    topic,
    description,
    groundedNote,
    post,
    client,
    channelId,
  } = opts;

  await post({
    text: `🧱 Prototype: ${project.summary}`,
    blocks: scaffoldReviewBlocks({
      scaffoldId,
      topic,
      description,
      project,
      groundedNote,
    }),
  });

  let uploaded = false;
  if (client && channelId) {
    uploaded = await uploadFiles(project, client, channelId);
  }
  if (!uploaded) {
    await postInline(project, post);
  }
}
