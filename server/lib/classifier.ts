import { generateText } from "ai";
import { google } from "@ai-sdk/google";

export type MessageType = "decision" | "blocker" | "question" | "none";

export interface ClassifiedMessage {
  type: MessageType;
  topic: string | null;
  summary: string | null;
}

export async function classifyMessage(
  text: string
): Promise<ClassifiedMessage> {
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

- "summary": one sentence capturing the decision/blocker/question.
  Use null if type is "none".

Return ONLY valid JSON. No markdown, no explanation, no code fences.

Message: "${text.replace(/"/g, '\\"')}"`,
  });

  try {
    return JSON.parse(response.trim()) as ClassifiedMessage;
  } catch {
    return { type: "none", topic: null, summary: null };
  }
}