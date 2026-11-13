import { NextResponse } from "next/server";
import { ACTIONS, validateLevel, validatePlan, type Action } from "@/lib/level";
import { HttpError, NO_STORE, fail, failFrom, frames as parseFrames, readJson } from "@/lib/server/http";
import { decide, type DecisionAnswer, type DecisionQuestion } from "@/lib/server/providers";

export const runtime = "nodejs";

// THE PLAYER. One Jev call per tick answers:
//   state         choice  which plan state the LAST frame is in
//   action        choice  best control right now (used by "act" states)
//   box:<target>  box     where each target is (steering + overlay)
//   seen:<target> noul    is it actually visible (box always returns one)
//
// The client turns this into controls: steer by the target's box, search,
// pick an action, or fire an interaction. Scoring is NOT done here — the
// referee (/api/referee) judges outcomes independently.

type Body = {
  level: unknown;
  plan?: unknown; // the planner may have replaced the designer's plan
  current: string;
  frames: string[];
  history?: { action: string; state: string }[];
  afters?: string[];
};

export async function POST(request: Request) {
  let body: Body, level, frames: string[];
  try {
    body = await readJson<Body>(request, 1_000_000);
    level = validateLevel(body.level);
    if (body.plan) level.plan = validatePlan(body.plan, new Set(level.targets.map((t) => t.id)));
    frames = parseFrames(body.frames);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Invalid request", e instanceof HttpError ? e.status : 400);
  }
  const plan = level.plan;
  const current = plan.nodes.find((n) => n.id === body.current) ?? plan.nodes[0];

  const questions: Record<string, DecisionQuestion> = {
    state: {
      type: "choice",
      instructions:
        "Which of these game states best describes the LAST image? Judge only what is visible right now. The previous state was given as PREVIOUS STATE; states usually advance along the plan, but choose whatever the image actually shows.",
      criteria: Object.fromEntries(plan.nodes.map((n) => [n.id, n.when])),
    },
    action: {
      type: "choice",
      instructions: `Choose the single control to HOLD next that best advances the GOAL from the LAST image. Movement is relative to the camera. If recent controls made no visible progress, change approach.`,
      criteria: ACTIONS as Record<Action, string>,
    },
  };
  for (const t of level.targets) {
    questions[`box:${t.id}`] = { type: "box", instructions: `In the LAST image: ${t.describe}` };
    questions[`seen:${t.id}`] = {
      type: "noul",
      instructions: `Is ${t.describe} clearly visible in the LAST image? Visible evidence only.`,
    };
  }

  const history = (body.history ?? []).slice(-6).map((h) => `${h.state}:${h.action}`).join(", ");
  const context = [
    `GAME: ${level.title}. GOAL: ${level.goal}.`,
    `VIEWPOINT: ${level.viewpoint}`,
    `PLAN: ${plan.nodes.map((n) => `${n.id} (${n.label}) -> [${n.next.join(", ")}]`).join("; ")}`,
    `PREVIOUS STATE: ${current.id} (${current.label}).`,
    body.afters?.length ? `ALREADY HAPPENED: ${body.afters.join(" ")}` : "",
    history ? `RECENT state:control (oldest first): ${history}.` : "",
    `${frames.length} frame(s) follow in chronological order; the LAST one is the current view.`,
  ]
    .filter(Boolean)
    .join("\n");

  const started = performance.now();
  try {
    const { answers, model } = await decide(context, frames, questions,
      AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]));
    const noul = (k: string) => {
      const a = answers[k] as DecisionAnswer | undefined;
      return a?.type === "noul" ? a.noul : null;
    };
    const choice = (k: string) => {
      const a = answers[k];
      return a?.type === "choice" ? { choice: a.choice, probabilities: a.probabilities } : null;
    };
    const boxes: Record<string, unknown> = {};
    for (const t of level.targets) {
      const b = answers[`box:${t.id}`];
      if (b?.type === "box") boxes[t.id] = { box: b.box, seen: noul(`seen:${t.id}`), confidence: b.confidence };
    }
    return NextResponse.json(
      {
        state: choice("state"),
        action: choice("action"),
        boxes,
        model,
        latencyMs: Math.round(performance.now() - started),
      },
      { headers: NO_STORE },
    );
  } catch (e) {
    return failFrom(e);
  }
}
