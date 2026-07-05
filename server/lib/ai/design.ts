import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import { z } from "zod";
import {
  type DecisionRecord,
  type ExpertRecord,
  normalizeTopic,
  queryDecisions,
  whoKnows,
} from "~/lib/graph";

// ---------------------------------------------------------------------------
// UI component vocabulary. This is our own intermediate representation — the
// source of truth for a design — which we render INTO Slack Block Kit for
// display and OUT OF for editing. We don't store raw Block Kit because it can't
// be round-tripped back into an editable form cleanly.
// ---------------------------------------------------------------------------

export const COMPONENT_TYPES = [
  "header",
  "section",
  "input",
  "textarea",
  "select",
  "button",
  "activity",
  "image",
  "divider",
  "context",
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];

/** Shape the model returns (no id — we assign stable ids ourselves). */
export const componentSchema = z.object({
  type: z.enum(COMPONENT_TYPES),
  label: z
    .string()
    .optional()
    .describe("Field label, header text, or button caption"),
  text: z
    .string()
    .optional()
    .describe("Body copy for section/context components"),
  placeholder: z
    .string()
    .optional()
    .describe("Placeholder shown inside an input/textarea/select"),
  required: z
    .boolean()
    .optional()
    .describe("Whether an input field is mandatory"),
  options: z
    .array(z.string())
    .optional()
    .describe("Choices for a select/dropdown"),
  items: z
    .array(z.string())
    .optional()
    .describe("Rows for an activity feed / list component"),
  style: z
    .enum(["primary", "danger", "default"])
    .optional()
    .describe("Visual emphasis for a button"),
  imageUrl: z.string().optional().describe("URL for an image component"),
  altText: z.string().optional().describe("Alt text describing an image"),
});

export type UIComponentInput = z.infer<typeof componentSchema>;
export type UIComponent = UIComponentInput & { id: string };
export type UISpec = UIComponent[];

export const designSchema = z.object({
  title: z.string().describe("Short screen title, e.g. 'User Profile'"),
  topic: z
    .string()
    .describe("snake_case topic label for team memory, e.g. 'user_profile'"),
  components: z
    .array(componentSchema)
    .describe("The screen's UI components, ordered top to bottom"),
});

/** Compact enrichment snapshot stored alongside the design for re-rendering. */
export interface DesignEnrichment {
  decisions: string[];
  experts: Array<{ id: string; name: string }>;
}

export interface DesignResult {
  title: string;
  topic: string;
  spec: UISpec;
  enrichment: DesignEnrichment;
  groundingDecisions: DecisionRecord[];
  experts: ExpertRecord[];
}

let componentCounter = 0;

/** Stable, short, collision-resistant component id (fits Slack's 75-char option value). */
export function newComponentId(): string {
  componentCounter += 1;
  return `c${Date.now().toString(36)}${componentCounter}`;
}

/**
 * Turn a PM's natural-language feature request into a UI component spec,
 * grounded in the team's past decisions and expertise.
 */
export async function generateDesign(
  description: string,
  teamId: string,
  topicHint?: string,
): Promise<DesignResult> {
  const seed = topicHint?.trim() || description;
  const [groundingDecisions, experts] = await Promise.all([
    queryDecisions(seed, teamId).catch(() => [] as DecisionRecord[]),
    whoKnows(seed, teamId).catch(() => [] as ExpertRecord[]),
  ]);

  const priorContext =
    groundingDecisions.length > 0
      ? `\n\nRelevant past decisions you should respect in the design:\n${groundingDecisions
          .map((d) => `- ${d.summary}`)
          .join("\n")}`
      : "\n\nNo prior decisions were found for this area; use sensible defaults.";

  const { object } = await generateObject({
    model: google("gemini-2.5-flash"),
    schema: designSchema,
    prompt: `You are Blueprint, a design tool inside Slack. Turn a PM's plain-English feature request into an INTERACTIVE UI MOCKUP described as an ordered list of components. This is a real product screen layout — not documentation, not code.

Feature request from the PM:
"${description}"
${priorContext}

Use ONLY these component types, choosing the ones that best represent the actual screen:
- "header": the screen title.
- "section": a block of display text / label / description.
- "input": a single-line form field (has label, placeholder, required).
- "textarea": a multi-line form field (has label, placeholder).
- "select": a dropdown (label + options[]).
- "button": a call-to-action (label + style).
- "activity": a feed/list of items (label + items[]), e.g. recent activity, history rows.
- "image": an image placeholder (imageUrl + altText).
- "divider": a visual separator.
- "context": small secondary/help text.

Rules:
- Design the screen a user would actually see. For "a user profile page that shows activity history and lets users update their email", produce e.g. a header, a section for the profile summary, an input for email (required), a save button, a divider, and an activity component listing recent history rows.
- Give inputs realistic labels and placeholders. Give activity components 3-5 concrete example items.
- Order components top-to-bottom the way they'd appear on screen.
- Keep it focused: 5-10 components. Don't invent unrelated features.`,
  });

  const spec: UISpec = object.components.map((c) => ({
    ...c,
    id: newComponentId(),
  }));

  const enrichment: DesignEnrichment = {
    decisions: groundingDecisions.map((d) => d.summary),
    experts: experts.map((e) => ({ id: e.personId, name: e.personName })),
  };

  return {
    title: object.title,
    topic: normalizeTopic(object.topic || seed),
    spec,
    enrichment,
    groundingDecisions,
    experts,
  };
}
