import { cerebras } from "@ai-sdk/cerebras";
import { google } from "@ai-sdk/google";
import { groq } from "@ai-sdk/groq";
import { mistral } from "@ai-sdk/mistral";
import { generateText } from "ai";

// Loose model type: providers ship different AI SDK spec versions (v2/v3/v4),
// so we accept any and cast at the call site rather than pin all to one spec.
type AnyModel = ReturnType<typeof google> | unknown;

// Each free provider has its own quota, so spreading requests across them
// multiplies effective RPM. A provider is only included if its API key is set.
interface Candidate {
  name: string;
  model: () => AnyModel;
}

const ALL: Array<{ env: string; name: string; model: () => AnyModel }> = [
  { env: "GOOGLE_GENERATIVE_AI_API_KEY", name: "gemini", model: () => google("gemini-2.5-flash") },
  // llama-3.1-8b-instant: 14.4K req/day, fast & cheap — best for short classification.
  { env: "GROQ_API_KEY", name: "groq-8b", model: () => groq("llama-3.1-8b-instant") },
  // gpt-oss-120b: 2.4K req/day, production tier.
  { env: "CEREBRAS_API_KEY", name: "cerebras-oss120b", model: () => cerebras("gpt-oss-120b") },
  // mistral-small-2506: 2.25M TPM, 5 RPS — highest free throughput.
  { env: "MISTRAL_API_KEY", name: "mistral-small", model: () => mistral("mistral-small-2506") },
];


const providers: Candidate[] = ALL.filter((p) => process.env[p.env]);

let cursor = 0;

function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|rate.?limit|quota|resource.?exhausted/i.test(msg);
}

/**
 * Generate text, rotating across configured free providers per call to balance
 * load. On a rate limit, advance to the next provider; only fail when all are
 * exhausted.
 */
export async function generateBalanced(prompt: string): Promise<string> {
  if (providers.length === 0) {
    throw new Error("[rotation] no AI providers configured — set at least one API key");
  }
  let lastErr: unknown;
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[(cursor + i) % providers.length];
    try {
      const { text } = await generateText({ model: provider.model() as Parameters<typeof generateText>[0]["model"], prompt });
      cursor = (cursor + i + 1) % providers.length; // start at next provider next time
      return text;
    } catch (err) {
      lastErr = err;
      if (!isRateLimit(err)) throw err;
      console.warn(`[rotation] ${provider.name} rate-limited, trying next provider`);
    }
  }
  cursor = (cursor + 1) % providers.length;
  throw lastErr;
}
