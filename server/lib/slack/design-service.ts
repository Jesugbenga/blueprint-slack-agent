import type { WebClient } from "@slack/web-api";
import type { DesignEnrichment, UISpec } from "~/lib/ai/design";
import { getDesign, updateDesignSpec } from "~/lib/graph";
import {
  type DesignStatus,
  renderDesignBlocks,
} from "~/lib/slack/design-blocks";

export interface DesignState {
  title: string;
  status: DesignStatus;
  spec: UISpec;
  enrichment: DesignEnrichment;
}

/** Load and parse a design's current state from Neo4j. */
export async function loadDesignState(
  designId: string,
  teamId: string,
): Promise<DesignState | null> {
  const record = await getDesign(designId, teamId);
  if (!record) return null;
  return {
    title: record.title,
    status: (record.status as DesignStatus) ?? "draft",
    spec: safeParse<UISpec>(record.spec, []),
    enrichment: safeParse<DesignEnrichment>(record.enrichment, {
      decisions: [],
      experts: [],
    }),
  };
}

/** Re-render the design message in place (Block Kit + preserved metadata). */
export async function rerenderDesignMessage(
  client: WebClient,
  opts: {
    designId: string;
    channel: string;
    messageTs: string;
    state: DesignState;
  },
): Promise<void> {
  const { designId, channel, messageTs, state } = opts;
  await client.chat.update({
    channel,
    ts: messageTs,
    text: `Design: ${state.title}`,
    blocks: renderDesignBlocks({
      designId,
      title: state.title,
      spec: state.spec,
      status: state.status,
      enrichment: state.enrichment,
    }),
    metadata: {
      event_type: "blueprint_design",
      event_payload: { designId },
    },
  });
}

/**
 * Load a design, apply a mutation to its component list, persist the new spec,
 * and re-render the message. Returns false if the design is missing or locked.
 */
export async function mutateAndRerender(
  client: WebClient,
  opts: {
    designId: string;
    teamId: string;
    channel: string;
    messageTs: string;
    mutate: (spec: UISpec) => UISpec;
  },
): Promise<boolean> {
  const { designId, teamId, channel, messageTs, mutate } = opts;
  const state = await loadDesignState(designId, teamId);
  if (!state || state.status === "approved") return false;

  const nextSpec = mutate(state.spec);
  await updateDesignSpec({
    designId,
    teamId,
    spec: JSON.stringify(nextSpec),
    status: "draft",
  });

  await rerenderDesignMessage(client, {
    designId,
    channel,
    messageTs,
    state: { ...state, spec: nextSpec },
  });
  return true;
}

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
