import { NextResponse } from "next/server";
import { ACTIONS, validateLevel, type Action } from "@/lib/level";
import {
  ConfigError,
  decide,
  type DecisionAnswer,
  type DecisionQuestion,
} from "@/lib/server/openrouter";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
const MAX_BODY = 3_000_000; // two small JPEGs + a level (possibly with a data: image)

// One Jev call per tick. Everything the player needs comes back in a single
// Decisions request:
//   action          choice  — the control to hold until the next tick
//   box:<target>    box     — where each target is (for the overlay)
//   seen:<target>   noul    — is it actually visible (box always returns one)
//   ready           noul    — can the stage interaction happen now
//   done            noul    — is the current stage visibly complete
//   blocked         noul    — would moving forward hit something

type Body = {
  level: unknown;
  stage: number;
  frames: string[]; // base64 JPEG, oldest first, LAST = current view
  history?: { action: Action; ms: number }[];
  afters?: string[];
  pending?: string | null;
};

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status, headers });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return bad("Origin not allowed", 403);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return bad("Request too large", 413);

  let body: Body;
  let level;
  try {
    body = JSON.parse(raw);
    level = validateLevel(body.level);
  } catch (e) {
    return bad(e instanceof Error ? e.message : "Invalid request");
  }
  const stage = level.stages[body.stage];
  if (!stage) return bad("Unknown stage");
  const frames = Array.isArray(body.frames) ? body.frames.slice(-2) : [];
  if (!frames.length || frames.some((f) => typeof f !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(f)))
    return bad("Supply one or two base64 JPEG frames");

  const target = level.targets.find((t) => t.id === stage.target)!;
  const history = (body.history ?? [])
    .slice(-6)
    .map((h) => `${h.action} for ${Math.round(h.ms)}ms`)
    .join(", ");

  const actions: Partial<Record<Action, string>> = { ...ACTIONS };
  if (stage.interaction) {
    actions.interact = `Perform "${stage.interaction.label}" on ${target.label}. ${ACTIONS.interact}`;
  } else {
    delete actions.interact;
  }

  const questions: Record<string, DecisionQuestion> = {
    action: {
      type: "choice",
      instructions: `You are playing a game inside a generated video world. Choose the single control to HOLD until the next decision that best advances the CURRENT OBJECTIVE, judging from the LAST image. Movement is relative to the camera. First get the target in view (turn), then center it, then approach it. If recent controls made no visible progress, try a different approach. ${
        body.pending
          ? "An interaction was just requested and is playing out: choose wait so its result can be observed."
          : ""
      }`,
      criteria: actions as Record<string, string>,
    },
    done: { type: "noul", instructions: stage.done },
    blocked: {
      type: "noul",
      instructions:
        "In the LAST image, would continuing to move forward immediately run into a wall, obstacle or impassable edge? Judge only the immediate path.",
    },
  };
  if (stage.ready) questions.ready = { type: "noul", instructions: stage.ready };
  for (const t of level.targets) {
    questions[`box:${t.id}`] = { type: "box", instructions: `In the LAST image: ${t.describe}` };
    questions[`seen:${t.id}`] = {
      type: "noul",
      instructions: `Is ${t.describe} clearly visible in the LAST image? Answer from visible evidence only.`,
    };
  }

  const context = [
    `GAME: ${level.title}. ${level.brief}`,
    `VIEWPOINT: ${level.viewpoint}`,
    `CURRENT OBJECTIVE (${body.stage + 1}/${level.stages.length}): ${stage.title}. Target: ${target.describe}.`,
    body.afters?.length ? `ALREADY ACCOMPLISHED: ${body.afters.join(" ")}` : "",
    history ? `RECENT CONTROLS (oldest first): ${history}.` : "",
    `The following ${frames.length} frame(s) are in chronological order; the LAST one is the current view.`,
  ]
    .filter(Boolean)
    .join("\n");

  const state = [
    context,
    ...frames.map((f) => ({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${f}` },
    })),
  ];

  const started = performance.now();
  try {
    const { answers, cost, model } = await decide(
      state,
      questions,
      AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    );
    const noul = (k: string) => {
      const a = answers[k] as DecisionAnswer | undefined;
      return a?.type === "noul" ? a.noul : null;
    };
    const act = answers.action;
    const boxes: Record<string, { box: unknown; seen: number | null; confidence?: number }> = {};
    for (const t of level.targets) {
      const b = answers[`box:${t.id}`];
      if (b?.type === "box") boxes[t.id] = { box: b.box, seen: noul(`seen:${t.id}`), confidence: b.confidence };
    }
    return NextResponse.json(
      {
        action: act?.type === "choice" ? act.choice : "wait",
        probabilities: act?.type === "choice" ? act.probabilities : {},
        done: noul("done"),
        ready: noul("ready"),
        blocked: noul("blocked"),
        boxes,
        cost,
        model,
        latencyMs: Math.round(performance.now() - started),
      },
      { headers },
    );
  } catch (e) {
    if (e instanceof ConfigError) return bad(e.message, 503);
    console.error(e);
    return bad(e instanceof Error ? e.message : "Jev call failed", 502);
  }
}
