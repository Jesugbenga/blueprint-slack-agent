import { google } from "@ai-sdk/google";
import { generateText } from "ai";
import { normalizeTopic } from "./graph";

export type MessageType = "decision" | "blocker" | "question" | "none";

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

  const { text: response } = await generateText({
    model: google("gemini-2.5-flash"),
    prompt: `Analyze this Slack message and return a JSON object with these exact fields:

- "type": one of "decision", "blocker", "question", or "none"
  - "decision": records a team decision ("we decided to...", "going with X", "agreed on...")
  - "blocker": someone is blocked or waiting ("blocked on...", "waiting for...", "can't proceed until...")
  - "question": an open question being asked ("how do we...", "has anyone...", "what's the best way...")
  - "none": casual chat, status updates, or anything else

- "topic": short snake_case label for what this relates to 
  (e.g. "auth_service", "checkout_flow", "database_migration")
  Use null if type is "none".
${knownTopicsSection}
- "summary": one sentence capturing the decision/blocker/question.
  Use null if type is "none".

Return ONLY valid JSON. No markdown, no explanation, no code fences.

Message: "${text.replace(/"/g, '\\"')}"`,
  });

  try {
    const parsed = JSON.parse(response.trim()) as ClassifiedMessage;
    // Keep topic labels stable so the graph doesn't fragment.
    if (parsed.topic) {
      parsed.topic = normalizeTopic(parsed.topic);
    }
    return parsed;
  } catch {
    return { type: "none", topic: null, summary: null };
  }
}
