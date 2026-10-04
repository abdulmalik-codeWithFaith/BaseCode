import type { AIProvider } from "./types.js";
import { AgentError } from "./errors.js";
import { GeminiProvider } from "./gemini.js";

export { AgentError };

/** Default per Google's docs: the recommended model for coding and agent work. Override with GEMINI_MODEL. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

function providerName(): string {
  return (process.env.AI_PROVIDER ?? "gemini").trim().toLowerCase();
}

function geminiKey(): string {
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
}

export function agentStatus(): { provider: string; model: string; configured: boolean } {
  const provider = providerName();
  return {
    provider,
    model: process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
    configured: provider === "gemini" && geminiKey().length > 0,
  };
}

/** The AI Adapter Layer: add new providers (OpenAI, Claude, ...) here. */
export function createProvider(): AIProvider {
  const name = providerName();
  if (name === "gemini") {
    const key = geminiKey();
    if (!key) {
      throw new AgentError(
        "No Gemini API key found. Create a file named .env inside the server folder containing a line like GEMINI_API_KEY=your-key (get one at https://aistudio.google.com/apikey), then restart the server.",
        "no_key",
      );
    }
    return new GeminiProvider(
      key,
      process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
      process.env.GEMINI_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL,
    );
  }
  throw new AgentError(`Unknown AI_PROVIDER "${name}". Supported: gemini.`, "bad_provider");
}