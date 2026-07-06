import { generateBalanced } from "./rotation";

/**
 * Pull a JSON object out of a model response. Models often wrap JSON in
 * ```json code fences or add a sentence around it, so we strip fences and fall
 * back to the outermost {...} block before parsing.
 */
export function extractJson(response: string): string {
  let text = response.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) text = fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    text = text.slice(first, last + 1);
  }
  return text;
}

/**
 * Run a prompt through the current active model (capacity-first rotation) and
 * parse the response as JSON. Returns `fallback` if the model returns something
 * that can't be parsed, so callers never have to wrap this in try/catch.
 */
export async function generateJson<T>(
  prompt: string,
  fallback: T,
  label = "generateJson",
): Promise<T> {
  const response = await generateBalanced(prompt);
  try {
    return JSON.parse(extractJson(response)) as T;
  } catch {
    console.warn(
      `[${label}] could not parse model response as JSON: ${response.slice(0, 200)}`,
    );
    return fallback;
  }
}
