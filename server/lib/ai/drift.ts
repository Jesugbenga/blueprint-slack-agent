import type { TopicDecisionRecord } from "../graph";
import { generateJson } from "./json";

export interface DriftProposal {
  /** Whether the message actually proposes/suggests a tech or architecture choice. */
  isProposal: boolean;
  /** The proposed approach in plain terms, e.g. "use MongoDB for the analytics service". */
  approach: string;
  /** Topic keywords used to look up related past decisions. */
  keywords: string[];
}

/** Decide whether a message proposes a technical direction, and extract it. */
export async function extractProposal(text: string): Promise<DriftProposal> {
  return generateJson<DriftProposal>(
    `You analyze a Slack message to see if it PROPOSES, SUGGESTS, or DISCUSSES adopting a
technology, tool, approach, or architectural choice (e.g. "let's use MongoDB", "we could switch to gRPC", "I think we should drop Redis").

Message: "${text.replace(/"/g, '\\"')}"

Return ONLY a JSON object:
- "isProposal": true only if it proposes/suggests/discusses a concrete technical or architectural choice. Casual chat, questions, and status updates are false.
- "approach": the proposed approach in a short phrase (e.g. "use MongoDB for analytics"). "" if not a proposal.
- "keywords": array of 1-4 short lowercase topic keywords for lookup (e.g. ["mongodb","database","analytics"]). [] if not a proposal.

Return ONLY valid JSON. No markdown, no code fences.`,
    { isProposal: false, approach: "", keywords: [] },
    "drift-extract",
  );
}

export interface DriftVerdict {
  /** True only when the proposal CONTRADICTS a past decision (not merely related). */
  contradiction: boolean;
  /** 0-1 confidence in the contradiction. */
  confidence: number;
  /** Index into the provided decisions list that is contradicted, or -1. */
  decisionIndex: number;
  /** One-line reason, used for logging/tuning. */
  reason: string;
}

/**
 * Compare a proposal against prior decisions and detect *contradiction*
 * specifically — not just topic overlap. Evolution/extension of a past decision
 * is NOT a contradiction.
 */
export async function detectContradiction(
  approach: string,
  decisions: TopicDecisionRecord[],
): Promise<DriftVerdict> {
  if (decisions.length === 0) {
    return {
      contradiction: false,
      confidence: 0,
      decisionIndex: -1,
      reason: "no prior decisions",
    };
  }

  const list = decisions.map((d, i) => `[${i}] ${d.summary}`).join("\n");

  return generateJson<DriftVerdict>(
    `You are Blueprint's drift detector. A teammate just proposed a technical direction.
Compare it against prior team decisions and detect CONTRADICTION only.

Proposed now: "${approach.replace(/"/g, '\\"')}"

Prior decisions (indexed):
${list}

Rules:
- CONTRADICTION = the proposal goes against a prior decision. Example: proposing "use MongoDB" when the team decided "do NOT use MongoDB for compliance reasons". → contradiction=true
- EVOLUTION / CONSISTENT = the proposal extends or aligns with a prior decision. Example: "add a new microservice" when the team decided "use microservices". → contradiction=false
- Same topic is NOT enough. Only flag a genuine conflict.

Return ONLY a JSON object:
- "contradiction": boolean
- "confidence": 0-1
- "decisionIndex": index [n] of the contradicted decision, or -1
- "reason": one short sentence

Return ONLY valid JSON. No markdown, no code fences.`,
    { contradiction: false, confidence: 0, decisionIndex: -1, reason: "" },
    "drift-detect",
  );
}

/** Ask the model to write an updated decision summary when the team confirms a new direction. */
export async function summarizeNewDirection(
  approach: string,
  supersededSummary: string,
): Promise<string> {
  const result = await generateJson<{ summary: string }>(
    `The team is changing a prior decision.

Old decision: "${supersededSummary.replace(/"/g, '\\"')}"
New direction: "${approach.replace(/"/g, '\\"')}"

Write ONE clear sentence recording the new decision (what they're now doing).
Return ONLY a JSON object: { "summary": "..." }. No markdown, no code fences.`,
    { summary: approach },
    "drift-summary",
  );
  return result.summary || approach;
}
