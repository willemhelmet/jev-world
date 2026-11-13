import { NextResponse } from "next/server";
import { validateLevel } from "@/lib/level";
import { HttpError, NO_STORE, fail, failFrom, frames as parseFrames, readJson } from "@/lib/server/http";
import { decide, type DecisionQuestion } from "@/lib/server/providers";

export const runtime = "nodejs";

// THE REFEREE. An independent Jev that sees only two frames (~1s apart) and
// the rubric — never the plan, the player's state or its chosen controls — and
// returns a probability for each scoring event. The client applies thresholds,
// cooldowns and the win condition.

type Body = { level: unknown; frames: string[]; open?: string[] };

export async function POST(request: Request) {
  let body: Body, level, frames: string[];
  try {
    body = await readJson<Body>(request, 1_000_000);
    level = validateLevel(body.level);
    frames = parseFrames(body.frames);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Invalid request", e instanceof HttpError ? e.status : 400);
  }
  // Only ask about events that can still score (the client says which).
  const open = new Set(body.open ?? level.rubric.events.map((e) => e.id));
  const events = level.rubric.events.filter((e) => open.has(e.id));
  if (!events.length) return NextResponse.json({ events: {} }, { headers: NO_STORE });

  const questions: Record<string, DecisionQuestion> = Object.fromEntries(
    events.map((e) => [e.id, { type: "noul", instructions: e.question }]),
  );
  const context = [
    `You are the referee of a game played inside a generated video world: ${level.title}.`,
    `GOAL: ${level.goal}. VIEWPOINT: ${level.viewpoint}`,
    frames.length > 1
      ? "Two frames follow: the FIRST was captured about one second before the LAST. Award nothing on intent or near misses; judge only what the frames show."
      : "One frame follows (the LAST image). Judge only what it shows.",
  ].join("\n");

  const started = performance.now();
  try {
    const { answers } = await decide(context, frames, questions,
      AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]));
    const out: Record<string, number> = {};
    for (const e of events) {
      const a = answers[e.id];
      if (a?.type === "noul") out[e.id] = a.noul;
    }
    return NextResponse.json(
      { events: out, latencyMs: Math.round(performance.now() - started) },
      { headers: NO_STORE },
    );
  } catch (e) {
    return failFrom(e);
  }
}
