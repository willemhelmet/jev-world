import "server-only";

// Both agents go through OpenRouter so one key runs the whole project:
//   - Jev (TypeSafe's decision model) via the alpha Decisions endpoint
//   - the level designer (Claude by default) via chat completions

const BASE = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api";

export const JEV_MODEL = process.env.JEV_MODEL ?? "typesafe/jev-1.14";
export const DESIGNER_MODEL =
  process.env.DESIGNER_MODEL ?? "anthropic/claude-opus-5.5";

export class ConfigError extends Error {}

function key() {
  const k = process.env.OPENROUTER_API_KEY;
  if (!k) throw new ConfigError("Add OPENROUTER_API_KEY to .env.local and restart.");
  return k;
}

async function post(path: string, body: unknown, signal?: AbortSignal) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    cache: "no-store",
    signal,
    headers: {
      Authorization: `Bearer ${key()}`,
      "Content-Type": "application/json",
      "X-Title": "jev-world",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenRouter ${path} returned ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

// ---- Decisions API -------------------------------------------------------

export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "box"; instructions: string };

export type DecisionAnswer =
  | { type: "noul"; noul: number; confidence?: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence?: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence?: number }
  | {
      type: "box";
      box: { top: number; bottom: number; left: number; right: number };
      confidence?: number;
    }
  | { type: "refusal" };

export async function decide(
  state: unknown[],
  questions: Record<string, DecisionQuestion>,
  signal?: AbortSignal,
): Promise<{ answers: Record<string, DecisionAnswer>; cost?: number; model?: string }> {
  const data = await post(
    "/alpha/decisions",
    { model: JEV_MODEL, state, questions },
    signal,
  );
  return { answers: data.answers ?? {}, cost: data.usage?.cost, model: data.model };
}

// ---- Chat (designer) -----------------------------------------------------

export async function chat(
  messages: unknown[],
  signal?: AbortSignal,
): Promise<string> {
  const data = await post(
    "/v1/chat/completions",
    {
      model: DESIGNER_MODEL,
      messages,
      max_tokens: 4000,
      response_format: { type: "json_object" },
    },
    signal,
  );
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Designer returned no content");
  return content;
}
