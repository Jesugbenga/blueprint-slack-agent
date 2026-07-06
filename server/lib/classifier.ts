import { generateBalanced } from "./ai/rotation";
import { normalizeTopic } from "./graph";

export type MessageType =
  | "decision"
  | "blocker"
  | "question"
  | "feature_request"
  | "none";

export interface ClassifiedMessage {
  type: MessageType;
  topic: string | null;
  summary: string | null;
}

export async function classifyMessage(
  text: string,
  knownTopics: string[] = [],
): Promise<ClassifiedMessage> {
  const knownTopicsSection =
    knownTopics.length > 0
      ? `\nExisting topics already in memory (REUSE the closest match if this message is about the same thing, instead of inventing a new label):\n${knownTopics.map((t) => `- ${t}`).join("\n")}\n`
      : "";

  const response = await generateBalanced(
    `Analyze this Slack message and return a JSON object with these exact fields:

- "type": one of "decision", "blocker", "question", "feature_request", or "none"
  - "decision": records a team decision ("we decided to...", "going with X", "agreed on...")
  - "blocker": someone is blocked or waiting ("blocked on...", "waiting for...", "can't proceed until...")
  - "question": an open question being asked ("how do we...", "has anyone...", "what's the best way...")
  - "feature_request": a request to build or add something new — intent language like
    "let's build", "we should add", "can we create", "I want to", "let's implement",
    "we need a", "build a", "add support for". Prefer this over "question" when the
    message is proposing work to be done rather than merely asking for information.
  - "none": casual chat, status updates, or anything else

- "topic": short snake_case label for what this relates to 
  (e.g. "auth_service", "checkout_flow", "database_migration")
  Use null if type is "none".
${knownTopicsSection}
- "summary": one sentence capturing the decision/blocker/question.
  Use null if type is "none".

Return ONLY valid JSON. No markdown, no explanation, no code fences.

Message: "${text.replace(/"/g, '\\"')}"`,
  );

  try {
    const parsed = JSON.parse(extractJson(response)) as ClassifiedMessage;
    // Keep topic labels stable so the graph doesn't fragment.
    if (parsed.topic) {
      parsed.topic = normalizeTopic(parsed.topic);
    }
    return parsed;
  } catch {
    console.warn(
      `[classifier] could not parse model response as JSON: ${response.slice(0, 200)}`,
    );
    return { type: "none", topic: null, summary: null };
  }
}

/**
 * Pull a JSON object out of a model response. Models often wrap JSON in
 * ```json code fences or add a sentence around it, so we strip fences and fall
 * back to the first {...} block before parsing.
 */
function extractJson(response: string): string {
  let text = response.trim();
  // Strip surrounding markdown code fences (```json ... ``` or ``` ... ```).
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) text = fence[1].trim();
  // If there's still extra prose, grab the outermost object.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    text = text.slice(first, last + 1);
  }
  return text;
}
