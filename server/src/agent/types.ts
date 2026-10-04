/** Provider-neutral types. Every AI provider adapter translates to and from these. */

export interface JsonSchema {
  type: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters?: JsonSchema;
}

export type Part =
  | { type: "text"; text: string }
  | {
      type: "tool_call";
      id: string;
      /** The id the provider gave this call, if it gave one (echoed back with the result). */
      providerId?: string;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      id: string;
      providerId?: string;
      name: string;
      result: Record<string, unknown>;
    };

export interface Message {
  role: "user" | "assistant";
  parts: Part[];
  /** Provider-native form of an assistant message, replayed verbatim (keeps thought signatures intact). */
  raw?: unknown;
}

export interface GenerateRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface GenerateResult {
  parts: Part[];
  raw?: unknown;
}

export interface AIProvider {
  readonly name: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/** Events streamed to the browser over /ws/agent. */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "approval_request"; id: string; name: string; args: Record<string, unknown>; dangerous: boolean }
  | {
      type: "tool_result";
      id: string;
      name: string;
      status: "ok" | "error" | "denied";
      summary: string;
      changed: boolean;
    }
  | { type: "done"; steps: number }
  | { type: "stopped" }
  | { type: "error"; message: string; code?: string };