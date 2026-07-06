import type { OpenItem } from "../graph";
import { generateJson } from "./json";

export interface HandoffBrief {
  /** One or two sentences framing the person's end-of-day state. */
  intro: string;
  /** A short "why it matters / next step" note per open item, aligned by index. */
  notes: string[];
}

/**
 * Turn a person's open items into a short, structured end-of-day handoff brief
 * using the current active model. Notes are aligned 1:1 with `items` by index so
 * the Block Kit builder can render them beside each item.
 */
export async function generateHandoffBrief(
  personName: string,
  items: OpenItem[],
): Promise<HandoffBrief> {
  if (items.length === 0) {
    return { intro: `${personName} has no open items to hand off.`, notes: [] };
  }

  const list = items
    .map((it, i) => `${i + 1}. [${it.kind}] ${it.summary}`)
    .join("\n");

  const fallback: HandoffBrief = {
    intro: `${personName} is wrapping up for the day. Here are open items that may need someone to pick up.`,
    notes: items.map(() => ""),
  };

  const result = await generateJson<HandoffBrief>(
    `You are Blueprint, a team-context agent. ${personName}'s workday is ending.
Write a concise end-of-day handoff brief for the team.

Open items (kept in order):
${list}

Return ONLY a JSON object with these fields:
- "intro": one or two sentences summarizing what's still open and why it matters. No greeting, no sign-off.
- "notes": an array of short strings, ONE per open item IN THE SAME ORDER, each a brief (max ~15 words) note on why it matters or the next step. Use "" if nothing useful to add.

Return ONLY valid JSON. No markdown, no code fences.`,
    fallback,
    "handoff",
  );

  // Guard: keep notes aligned to items even if the model returns the wrong count.
  const notes = items.map((_, i) => result.notes?.[i] ?? "");
  return { intro: result.intro || fallback.intro, notes };
}
