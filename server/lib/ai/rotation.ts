import { cerebras } from "@ai-sdk/cerebras";
import { google } from "@ai-sdk/google";
import { groq } from "@ai-sdk/groq";
import { mistral } from "@ai-sdk/mistral";
import { generateText } from "ai";

// Loose model type: providers ship different AI SDK spec versions (v2/v3/v4),
// so we accept any and cast at the call site rather than pin all to one spec.
type AnyModel = ReturnType<typeof google> | unknown;

// Providers are tried in order: drain the highest-capacity one first, only
// moving to the next once it's nearly out of daily quota (or is rate-limited).
// A provider is included only if its API key is set. `dailyMax` is the free-tier
// requests/day; we switch off a provider at THRESHOLD of that cap.
interface Candidate {
  env: string;
  name: string;
  dailyMax: number;
  model: () => AnyModel;
}

const THRESHOLD = 0.9; // leave 10% headroom before rotating off a provider

const ALL: Candidate[] = [
  // mistral-small-2506: 5 RPS, huge token budget — most capacity, used first.
  { env: "MISTRAL_API_KEY", name: "mistral-small", dailyMax: 100_000, model: () => mistral("mistral-small-2506") },
  // groq llama-3.1-8b-instant: 14.4K req/day, fast & cheap.
  { env: "GROQ_API_KEY", name: "groq-8b", dailyMax: 14_400, model: () => groq("llama-3.1-8b-instant") },
  // gemini-2.5-flash: RPM-limited free tier.
  { env: "GOOGLE_GENERATIVE_AI_API_KEY", name: "gemini", dailyMax: 1_500, model: () => google("gemini-2.5-flash") },
  // cerebras gpt-oss-120b: 2.4K req/day, production tier — last resort.
  { env: "CEREBRAS_API_KEY", name: "cerebras-oss120b", dailyMax: 2_400, model: () => cerebras("gpt-oss-120b") },
];

const providers = ALL.filter((p) => process.env[p.env]);

// Per-provider daily usage; resets at the start of each UTC day.
const used = new Map<string, number>();
let dayStamp = utcDay();
let cursor = 0;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function resetIfNewDay(): void {
  const today = utcDay();
  if (today !== dayStamp) {
    used.clear();
    dayStamp = today;
    cursor = 0;
  }
}

function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|rate.?limit|quota|resource.?exhausted/i.test(msg);
}

/**
 * Generate text using a capacity-first strategy: keep using the current
 * highest-priority provider until it nears its cap, then advance. When all
 * providers are exhausted it wraps back to the first and starts over, so the
 * agent never stops. On a rate limit, skip ahead to the next provider.
 */
export async function generateBalanced(prompt: string): Promise<string> {
  if (providers.length === 0) {
    throw new Error("[rotation] no AI providers configured — set at least one API key");
  }
  resetIfNewDay();

  // Advance past providers at/over threshold; wrap to the start if all are full.
  for (let scanned = 0; scanned < providers.length; scanned++) {
    const p = providers[cursor];
    if ((used.get(p.name) ?? 0) < p.dailyMax * THRESHOLD) break;
    cursor++;
    if (cursor >= providers.length) {
      used.clear(); // all exhausted — reset budgets and start over from the top
      cursor = 0;
      break;
    }
  }

  let lastErr: unknown;
  for (let n = 0; n < providers.length; n++) {
    const provider = providers[cursor];
    try {
      const { text } = await generateText({
        model: provider.model() as Parameters<typeof generateText>[0]["model"],
        prompt,
      });
      used.set(provider.name, (used.get(provider.name) ?? 0) + 1);
      return text;
    } catch (err) {
      lastErr = err;
      if (!isRateLimit(err)) throw err;
      used.set(provider.name, provider.dailyMax); // treat as exhausted, move on
      cursor = (cursor + 1) % providers.length; // wrap around to keep going
      console.warn(`[rotation] ${provider.name} rate-limited, advancing to next provider`);
    }
  }
  throw lastErr;
}
