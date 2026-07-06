import { generateJson } from "./ai/json";

/** The seven things a well-formed feature request should specify. */
export type GapKey =
  | "owner"
  | "scope"
  | "usersAffected"
  | "dependencies"
  | "acceptanceCriteria"
  | "deadline"
  | "stakeholders";

export interface Gap {
  key: GapKey;
  /** Human-readable label, e.g. "Owner". */
  label: string;
  /** Why this gap matters — shown under the item. */
  why: string;
  /** Best-effort value inferred from context to pre-fill the modal (may be ""). */
  suggestion: string;
}

export interface GapAnalysis {
  /** Short feature title inferred from the request. */
  title: string;
  /** snake_case topic keyword for graph linkage. */
  topic: string;
  /** Only the items that are actually missing or ambiguous. */
  gaps: Gap[];
  /**
   * Note surfaced when the request touches an area with a relevant past
   * decision, e.g. "This touches auth — the team chose OAuth2 for SSO." "" if none.
   */
  dependencyNote: string;
}

/**
 * Evaluate a feature request against the seven-point checklist and return only
 * the items that are missing or ambiguous, plus any dependency note grounded in
 * the team's related decisions.
 */
export async function detectGaps(
  text: string,
  relatedDecisions: string[],
): Promise<GapAnalysis> {
  const decisionsBlock =
    relatedDecisions.length > 0
      ? relatedDecisions.map((d) => `- ${d}`).join("\n")
      : "(none found)";

  const fallback: GapAnalysis = {
    title: "New feature",
    topic: "feature_request",
    gaps: [],
    dependencyNote: "",
  };

  return generateJson<GapAnalysis>(
    `You are Blueprint. A feature request was just posted. Evaluate it against this checklist and
identify ONLY the items that are missing or ambiguous (do not list items that are clearly stated).

Checklist (use these exact keys/labels):
- owner ("Owner"): is a named person responsible?
- scope ("Scope"): mobile, web, both? backend only? full stack?
- usersAffected ("Users affected"): who is this for?
- dependencies ("Dependencies"): does it touch auth, payments, databases, or other services?
- acceptanceCriteria ("Acceptance criteria"): how will we know it's done?
- deadline ("Deadline / priority"): when does it need to ship?
- stakeholders ("Stakeholders"): are the right teams/experts mentioned?

Feature request: "${text.replace(/"/g, '\\"')}"

Related past decisions the team has already made:
${decisionsBlock}

Return ONLY a JSON object:
- "title": short feature title
- "topic": snake_case keyword (e.g. "analytics_dashboard")
- "gaps": array of ONLY the missing/ambiguous items, each { "key", "label", "why" (one sentence), "suggestion" (inferred value or "") }
- "dependencyNote": if the request touches an area covered by a related decision above, one sentence surfacing it (e.g. "This touches authentication — the team chose OAuth2 for enterprise SSO; make sure it's compatible."). Otherwise "".

Return ONLY valid JSON. No markdown, no code fences.`,
    fallback,
    "gap-detect",
  );
}
