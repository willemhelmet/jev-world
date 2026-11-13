import { NextResponse } from "next/server";
import { validateLevel, validatePlan } from "@/lib/level";
import { HttpError, NO_STORE, fail, failFrom, frames as parseFrames, readJson } from "@/lib/server/http";
import { design, plannerModel } from "@/lib/server/providers";
import { PLAN_RULES, WORLD_RULES } from "@/lib/server/prompts";

export const runtime = "nodejs";

// THE PLANNER. Called when the player has been stuck in one state for a
// while. Sees the current frame, the goal, the current plan and recent
// history, and returns a revised plan graph (same JSON shape).

type Body = {
  level: unknown;
  plan?: unknown;
  current: string;
  frames: string[];
  history?: { action: string; state: string }[];
  score?: number;
  stuckS?: number;
};

const SYSTEM = `You are the PLANNER for an AI player in a game inside a generated video world.
${WORLD_RULES}

${PLAN_RULES}

The player is stuck. Look at the current frame, figure out why the current plan is not working (wrong state descriptions? needs a different approach? target not visible?), and return a revised plan. You may change states, modes, targets (from the given targets only), "when" descriptions and edges. Keep what works.

Reply with ONLY a JSON object: {"reason": "<one short sentence for the HUD>", "plan": {"start": "<id>", "nodes": [...]}}`;

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
  const user = [
    `GAME: ${level.title}. GOAL: ${level.goal}. VIEWPOINT: ${level.viewpoint}`,
    `TARGETS: ${JSON.stringify(level.targets)}`,
    `CURRENT PLAN: ${JSON.stringify(level.plan)}`,
    `The player has been in state "${body.current}" for ${Math.round(body.stuckS ?? 0)}s with score ${body.score ?? 0}.`,
    `RECENT state:control: ${(body.history ?? []).slice(-12).map((h) => `${h.state}:${h.action}`).join(", ") || "none"}`,
    "The attached image is the current frame. Return the revised plan JSON.",
  ].join("\n");
  const started = performance.now();
  try {
    const text = await design(
      SYSTEM,
      `data:image/jpeg;base64,${frames[frames.length - 1]}`,
      user,
      AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
      plannerModel(),
    );
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const plan = validatePlan(json.plan, new Set(level.targets.map((t) => t.id)));
    return NextResponse.json(
      { plan, reason: String(json.reason ?? "").slice(0, 120), latencyMs: Math.round(performance.now() - started) },
      { headers: NO_STORE },
    );
  } catch (e) {
    return failFrom(e);
  }
}
