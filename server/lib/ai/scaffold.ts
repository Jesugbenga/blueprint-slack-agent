import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import { z } from "zod";
import {
  type BlockerRecord,
  type DecisionRecord,
  queryBlockers,
  queryDecisions,
} from "~/lib/graph";

/** A single generated source file in the prototype. */
export const scaffoldFileSchema = z.object({
  path: z
    .string()
    .describe(
      "Relative file path, e.g. 'prisma/schema.prisma' or 'src/api/orders.ts'",
    ),
  language: z
    .string()
    .describe(
      "Language/format for syntax highlighting, e.g. 'typescript', 'prisma', 'sql', 'json'",
    ),
  description: z.string().describe("One line on what this file is for"),
  content: z.string().describe("The full file contents — real, runnable code"),
});

export type ScaffoldFile = z.infer<typeof scaffoldFileSchema>;

export const scaffoldProjectSchema = z.object({
  summary: z
    .string()
    .describe("One or two sentences restating the feature in concrete terms"),
  stack: z
    .string()
    .describe("The chosen tech stack, e.g. 'Next.js + Prisma + PostgreSQL'"),
  files: z
    .array(scaffoldFileSchema)
    .describe(
      "The generated project files an engineer can run and refine. Aim for 4-7 focused files.",
    ),
  setup: z
    .array(z.string())
    .describe(
      "Shell commands to install/run the prototype, in order (a few steps)",
    ),
  openQuestions: z
    .array(z.string())
    .describe(
      "Specific questions for the PM/engineer to resolve (a handful at most)",
    ),
});

export type ScaffoldProject = z.infer<typeof scaffoldProjectSchema>;

export interface ScaffoldResult {
  project: ScaffoldProject;
  /** Decisions used to ground the scaffold (for citations). */
  groundingDecisions: DecisionRecord[];
  /** Blockers used to ground the scaffold (for citations). */
  groundingBlockers: BlockerRecord[];
}

/**
 * Generate a runnable prototype (schema + API + supporting files) from a PM's
 * plain-English feature description, grounded in what Blueprint already knows
 * about the project — so engineers get something concrete to react to and
 * refine instead of a vague spec. This is the "Lovable/Replit in Slack" step.
 */
export async function generateScaffold(
  description: string,
  teamId: string,
  topicHint?: string,
): Promise<ScaffoldResult> {
  // Pull related prior context so the scaffold respects past decisions/blockers.
  const topic = topicHint?.trim() || description;
  const [groundingDecisions, groundingBlockers] = await Promise.all([
    queryDecisions(topic, teamId).catch(() => [] as DecisionRecord[]),
    queryBlockers(topic, teamId).catch(() => [] as BlockerRecord[]),
  ]);

  const priorContext =
    groundingDecisions.length > 0 || groundingBlockers.length > 0
      ? `\n\nExisting project context you MUST respect (do not contradict these — if the idea conflicts, raise it under openQuestions):\nDecisions:\n${
          groundingDecisions.map((d) => `- ${d.summary}`).join("\n") || "- none"
        }\nKnown blockers/concerns:\n${
          groundingBlockers.map((b) => `- ${b.summary}`).join("\n") || "- none"
        }`
      : "\n\nNo prior project context was found for this feature; pick sensible, mainstream defaults.";

  const { object } = await generateObject({
    model: google("gemini-2.5-flash"),
    schema: scaffoldProjectSchema,
    prompt: `You are Blueprint, a tool that turns a PM's feature idea into a small, runnable prototype an engineer can immediately pull, run, and refine — like Lovable or Replit, but delivered inside Slack.

Feature description from the PM:
"${description}"
${priorContext}

Generate a focused, COHERENT prototype:
- Choose ONE pragmatic, mainstream stack and stick to it across all files.
- Always include a data model (schema) and API layer (route handlers/stubs with real signatures and types).
- Include just enough supporting files to run it (e.g. a package.json with deps, an env example, a README with run steps). Keep it minimal — a starting point, not a finished product.
- Write REAL code in 'content', not placeholders or "// TODO implement everything".
- 'setup' must be the actual commands to install and start it.
- 'openQuestions' must be specific product/technical decisions the PM still needs to make.

Keep the whole thing small (aim for 4-7 files) so it stays reviewable in a Slack thread.`,
  });

  return { project: object, groundingDecisions, groundingBlockers };
}
