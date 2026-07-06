import { randomUUID } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import { detectGaps, type Gap } from "~/lib/gapDetector";
import { getDecisionsAboutTopic, saveGapDraft } from "~/lib/graph";
import { gapBlocks } from "~/lib/slack/gap-blocks";

/** Everything the modal submission needs to compile + store the final spec. */
export interface GapDraftPayload {
  text: string;
  title: string;
  topic: string;
  channel: string;
  threadTs: string;
  gaps: Gap[];
  dependencyNote: string;
  /** Ids of decisions this feature is informed by. */
  decisionIds: string[];
}

/**
 * Fires when the classifier tags a message as a feature request. Looks up
 * related decisions, evaluates the request for gaps, and — only if something is
 * actually missing — posts a proactive gap card in the thread.
 */
export async function handleFeatureRequest(opts: {
  client: WebClient;
  text: string;
  channel: string;
  threadTs: string;
  teamId: string;
  topic: string;
}): Promise<void> {
  const { client, text, channel, threadTs, teamId, topic } = opts;

  const related = await getDecisionsAboutTopic([topic], teamId).catch(() => []);
  const analysis = await detectGaps(
    text,
    related.map((d) => d.summary),
  );

  // Nothing missing — stay quiet.
  if (!analysis.gaps || analysis.gaps.length === 0) return;

  const draftId = randomUUID();
  const payload: GapDraftPayload = {
    text,
    title: analysis.title,
    topic: analysis.topic || topic,
    channel,
    threadTs,
    gaps: analysis.gaps,
    dependencyNote: analysis.dependencyNote,
    decisionIds: related.map((d) => d.id),
  };

  await saveGapDraft({ draftId, teamId, payload: JSON.stringify(payload) });

  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    blocks: gapBlocks({ analysis, draftId }),
    text: "Before engineering starts, I noticed a few gaps in this request.",
  });
}
