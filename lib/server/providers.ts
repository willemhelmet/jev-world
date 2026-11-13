import "server-only";

// Model providers for the two agents.
//
//   Jev (player)   TYPESAFE_API_KEY   -> api.typesafe.ai/v1/systemone      (preferred)
//                  OPENROUTER_API_KEY -> openrouter.ai/api/alpha/decisions
//   Designer       DESIGNER_BASE_URL + DESIGNER_API_KEY -> any OpenAI-compatible
//                  /chat/completions (Kimi K3 via an internal gateway, OpenAI, ...)
//                  OPENROUTER_API_KEY -> openrouter.ai/api/v1/chat/completions
//
// Whichever is configured wins; OpenRouter alone can run everything.

export class ConfigError extends Error {}

const TYPESAFE_URL = process.env.TYPESAFE_API_URL ?? "https://api.typesafe.ai";
const OPENROUTER_URL = process.env.OPENROUTER_API_URL ?? "https://openrouter.ai/api";

const env = (k: string) => process.env[k]?.trim() || undefined;

export function jevModel() {
  if (env("JEV_MODEL")) return env("JEV_MODEL")!;
  return env("TYPESAFE_API_KEY") ? "jev-latest" : "typesafe/jev-1.14";
}
export function plannerModel() {
  if (env("PLANNER_MODEL")) return env("PLANNER_MODEL")!;
  return env("DESIGNER_BASE_URL") ? "kimi-k3-low" : "moonshotai/kimi-k3";
}
export function designerModel() {
  if (env("DESIGNER_MODEL")) return env("DESIGNER_MODEL")!;
  return env("DESIGNER_BASE_URL") ? "kimi-k3-high" : "moonshotai/kimi-k3";
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  const res = await fetch(url, {
    method: "POST",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const host = new URL(url).host;
    throw new Error(`${host} returned ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

// ---- Decisions (Jev) -----------------------------------------------------

export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "box"; instructions: string };

export type DecisionAnswer =
  | { type: "noul"; noul: number; confidence?: number | null }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence?: number | null }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence?: number | null }
  | {
      type: "box";
      box: { top: number; bottom: number; left: number; right: number };
      confidence?: number | null;
    }
  | { type: "refusal" };

export type DecisionResult = {
  answers: Record<string, DecisionAnswer>;
  model?: string;
  cost?: number;
  inputTokens?: number;
};

/**
 * Ask Jev a set of questions about a text context followed by JPEG frames
 * (base64, no data: prefix), in chronological order.
 */
export async function decide(
  context: string,
  frames: string[],
  questions: Record<string, DecisionQuestion>,
  signal?: AbortSignal,
): Promise<DecisionResult> {
  const model = jevModel();
  const typesafe = env("TYPESAFE_API_KEY");
  if (typesafe) {
    // System One: images travel in `assets` and are referenced by placeholder
    // strings inside `state`. Placeholders must be unique and all referenced.
    const id = crypto.randomUUID();
    const keys = frames.map((_, i) => `frame-${i}-${id}`);
    const data = await postJson(
      `${TYPESAFE_URL}/v1/systemone`,
      { Authorization: `Bearer ${typesafe}`, "TypeSafe-Danger-Zone-Images": "true" },
      {
        model,
        state: [context, ...keys],
        questions,
        assets: Object.fromEntries(
          keys.map((k, i) => [k, { type: "image", format: "jpeg", data_base64: frames[i] }]),
        ),
      },
      signal,
    );
    return { answers: data.answers ?? {}, model: data.model, inputTokens: data.usage?.input_tokens };
  }
  const openrouter = env("OPENROUTER_API_KEY");
  if (openrouter) {
    const data = await postJson(
      `${OPENROUTER_URL}/alpha/decisions`,
      { Authorization: `Bearer ${openrouter}`, "X-Title": "jev-world" },
      {
        model,
        state: [
          context,
          ...frames.map((f) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${f}` } })),
        ],
        questions,
      },
      signal,
    );
    return {
      answers: data.answers ?? {},
      model: data.model,
      cost: data.usage?.cost,
      inputTokens: data.usage?.input_tokens,
    };
  }
  throw new ConfigError("Add TYPESAFE_API_KEY (or OPENROUTER_API_KEY) and restart.");
}

// ---- Designer ------------------------------------------------------------

/** One-shot: a system prompt plus one user turn of (optionally) an image and text. Returns raw text. */
export async function design(
  system: string,
  imageDataUrl: string | null,
  text: string,
  signal?: AbortSignal,
  model: string = designerModel(),
): Promise<string> {
  const custom = env("DESIGNER_BASE_URL");
  const key = custom ? env("DESIGNER_API_KEY") : env("OPENROUTER_API_KEY");
  if (!key)
    throw new ConfigError(
      custom
        ? "DESIGNER_BASE_URL is set but DESIGNER_API_KEY is empty."
        : "Set DESIGNER_BASE_URL + DESIGNER_API_KEY (any OpenAI-compatible API) or OPENROUTER_API_KEY.",
    );
  const base = custom ? custom.replace(/\/+$/, "") : `${OPENROUTER_URL}/v1`;
  const data = await postJson(
    `${base}/chat/completions`,
    { Authorization: `Bearer ${key}`, "X-Title": "jev-world" },
    {
      model,
      // Reasoning models (Kimi K3 always reasons) spend part of this budget thinking.
      max_tokens: 16000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            ...(imageDataUrl ? [{ type: "image_url", image_url: { url: imageDataUrl } }] : []),
            { type: "text", text },
          ],
        },
      ],
    },
    signal,
  );
  const out = data.choices?.[0]?.message?.content;
  if (typeof out !== "string" || !out) throw new Error("Designer returned no content");
  return out;
}
