import { randomUUID } from "node:crypto";
import type {
  AllMiddlewareArgs,
  SlackViewMiddlewareArgs,
  ViewSubmitAction,
} from "@slack/bolt";
import { deleteGapDraft, getGapDraft, storeFeature } from "~/lib/graph";
import { featureSpecBlocks } from "~/lib/slack/gap-blocks";
import type { GapDraftPayload } from "~/listeners/events/featureRequestHandler";

/** Pull a Slack user id out of a `<@U123>` mention, if present. */
function parseUserId(text: string): string | undefined {
  return text.match(/<@([A-Z0-9]+)/)?.[1];
}

/**
 * Handles the gap-fill modal submission: compiles the enriched spec, posts it
 * back to the originating thread, and stores the Feature in Neo4j wired to its
 * topic, owner, and the decisions that informed it.
 */
export const gapFillModalCallback = async ({
  ack,
  body,
  view,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs<ViewSubmitAction>) => {
  await ack();

  const teamId = body.team?.id;
  const draftId = view.private_metadata;
  if (!teamId || !draftId) return;

  const raw = await getGapDraft(draftId, teamId).catch(() => null);
  if (!raw) {
    logger.warn("[gap] draft not found on modal submit");
    return;
  }
  const payload = JSON.parse(raw) as GapDraftPayload;

  // Collect the filled-in values by gap key, falling back to the inferred suggestion.
  const values: Record<string, string> = {};
  for (const gap of payload.gaps) {
    const input =
      view.state.values[`gap_${gap.key}`]?.value?.value ?? gap.suggestion ?? "";
    values[gap.key] = input.trim();
  }

  const ownerText = values.owner ?? "";
  const ownerId = parseUserId(ownerText);

  const fields = payload.gaps.map((gap) => ({
    label: gap.label,
    value: values[gap.key] ?? "",
  }));

  const blocks = featureSpecBlocks({
    title: payload.title,
    ownerLine: ownerText,
    fields,
    dependencyNote: payload.dependencyNote,
  });

  await client.chat.postMessage({
    channel: payload.channel,
    thread_ts: payload.threadTs,
    blocks,
    text: `Enriched spec for ${payload.title}`,
  });

  await storeFeature({
    featureId: randomUUID(),
    teamId,
    title: payload.title,
    description: payload.text,
    owner: ownerText,
    scope: values.scope ?? "",
    deadline: values.deadline ?? "",
    acceptanceCriteria: values.acceptanceCriteria ?? "",
    topic: payload.topic,
    ownerId,
    ownerName: ownerId ? undefined : ownerText || undefined,
    informedByDecisionIds: payload.decisionIds,
  }).catch((err) => logger.error("[gap] storeFeature failed:", err));

  await deleteGapDraft(draftId, teamId).catch(() => {});
};
