import { AgentError } from "./errors.js";
import type { AIProvider, GenerateRequest, GenerateResult, JsonSchema, Message, Part, ToolSpec } from "./types.js";

/** Minimal shapes of the Gemini generateContent REST API (v1beta) that we rely on. */
interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  [other: string]: unknown; // thoughtSignature and any future metadata ride along untouched
}
interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}
interface GeminiResponse {
  candidates?: { content?: GeminiContent; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

const REQUEST_TIMEOUT_MS = 180_000;

/** Gemini rejects OBJECT schemas with empty properties, so no-argument tools omit `parameters`. */
function toDeclaration(tool: ToolSpec) {
  const hasProps = tool.parameters?.properties && Object.keys(tool.parameters.properties).length > 0;
  return {
    name: tool.name,
    description: tool.description,
    ...(hasProps ? { parameters: tool.parameters as JsonSchema } : {}),
  };
}

function toGeminiContent(msg: Message): GeminiContent {
  if (msg.role === "assistant") {
    // Replay exactly what the model produced (including thought signatures) when we have it.
    if (msg.raw && typeof msg.raw === "object") return msg.raw as GeminiContent;
    return {
      role: "model",
      parts: msg.parts.flatMap((p): GeminiPart[] => {
        if (p.type === "text") return [{ text: p.text }];
        if (p.type === "tool_call") return [{ functionCall: { name: p.name, args: p.args } }];
        return [];
      }),
    };
  }
  return {
    role: "user",
    parts: msg.parts.flatMap((p): GeminiPart[] => {
      if (p.type === "text") return [{ text: p.text }];
      if (p.type === "tool_result") {
        return [
          {
            functionResponse: {
              name: p.name,
              response: p.result,
              ...(p.providerId ? { id: p.providerId } : {}),
            },
          },
        ];
      }
      return [];
    }),
  };
}

function friendlyHttpError(status: number, message: string, model: string): AgentError {
  if (status === 400 && /api key/i.test(message)) {
    return new AgentError("Gemini rejected the API key. Check GEMINI_API_KEY in server/.env.", "bad_key");
  }
  if (status === 401 || status === 403) {
    return new AgentError(`Gemini refused the request (${status}): ${message}`, "auth");
  }
  if (status === 404) {
    return new AgentError(
      `Gemini model "${model}" was not found for your key. Set GEMINI_MODEL in server/.env to a current model (see https://ai.google.dev/gemini-api/docs/models).`,
      "bad_model",
    );
  }
  if (status === 429) {
    return new AgentError("Gemini rate limit or quota reached. Wait a bit, or check your plan and quota in Google AI Studio.", "rate_limit");
  }
  if (status >= 500) {
    return new AgentError(`Gemini is having trouble right now (${status}). Try again in a moment.`, "upstream");
  }
  return new AgentError(`Gemini error ${status}: ${message}`, "upstream");
}

export class GeminiProvider implements AIProvider {
  readonly name = "gemini";

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string,
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map(toGeminiContent),
      tools: [{ functionDeclarations: req.tools.map(toDeclaration) }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    };

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (req.signal?.aborted) throw err; // user pressed Stop; the loop handles it
      if (timeout.aborted) throw new AgentError("Gemini took too long to respond. Try again.", "timeout");
      throw new AgentError(`Could not reach Gemini: ${(err as Error).message}`, "network");
    }

    const data = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (!res.ok) throw friendlyHttpError(res.status, data.error?.message ?? res.statusText, this.model);

    const candidate = data.candidates?.[0];
    const content = candidate?.content;
    if (!content?.parts?.length) {
      const why = data.promptFeedback?.blockReason ?? candidate?.finishReason ?? "no content";
      throw new AgentError(`Gemini returned no answer (${why}). Try rephrasing the request.`, "empty");
    }

    let n = 0;
    const parts: Part[] = [];
    for (const p of content.parts) {
      if (p.functionCall) {
        parts.push({
          type: "tool_call",
          id: p.functionCall.id ?? `call_${Date.now().toString(36)}_${n++}`,
          providerId: p.functionCall.id,
          name: p.functionCall.name,
          args: p.functionCall.args ?? {},
        });
      } else if (typeof p.text === "string" && p.text.length > 0 && p.thought !== true) {
        parts.push({ type: "text", text: p.text });
      }
    }

    return { parts, raw: { role: "model", parts: content.parts } };
  }
}