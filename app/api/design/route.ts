import { NextResponse } from "next/server";
import { validateLevel } from "@/lib/level";
import { HttpError, NO_STORE, fail, failFrom, readJson } from "@/lib/server/http";
import { generateScene, imageGenAvailable, toDataUrl } from "@/lib/server/images";
import { design, designerModel } from "@/lib/server/providers";
import { EXAMPLE_LEVEL, PLAN_RULES, RUBRIC_RULES, WORLD_RULES } from "@/lib/server/prompts";

export const runtime = "nodejs";
export const maxDuration = 300;

// THE DESIGNER. LingBot World 2 needs an opening image, so the designer's
// first job is to produce one. Two modes:
//
//   "scratch"  theme → (1) Kimi writes a scene → (2) image model renders the
//              opening frame → (3) Kimi designs the level LOOKING AT that frame
//   "edit"     existing image + theme → (1) Kimi designs the level and an edit
//              instruction → (2) image model adds the level's objects to it

const LEVEL_TYPE = `type Level = { id: string; title: string; brief: string; goal: string; imagePrompt: string; viewpoint: string;
  prompt: { base: string; moving: string; still: string };
  targets: { id: string; label: string; describe: string }[];
  plan: { start: string; nodes: { id: string; label: string; when: string; mode: "search"|"steer"|"act"|"interact";
    target?: string; actions?: string[]; interaction?: { label: string; event: string; after: string }; next: string[] }[] };
  rubric: { events: { id: string; label: string; question: string; points: number; repeat: boolean; cooldownS?: number; evidence?: { target: string; minSize: number } }[];
    winPoints?: number; winEvent?: string; timeLimitS: number } };`;

const LEVEL_SYSTEM = `You design short game levels played inside LingBot World 2 (a real-time image-to-video world model) by an AI player called Jev, scored by an independent AI referee.
${WORLD_RULES}

Design rules:
- Build on what is ACTUALLY in the image (subject, viewpoint, environment, style, and any challenge objects already present). In edit mode you may add 1-3 new objects; make them BIG, bright and distinctive.
- "imagePrompt": in edit mode, an EDIT instruction that adds your new objects to the image ("add …, keep everything else exactly the same"). If the image already contains everything, repeat a short description of the scene.
- prompt.base restates the subject, viewpoint, environment, style AND the challenge objects (with "EXACTLY ONE …" or exact counts). prompt.moving / prompt.still describe the subject's motion while controls are held / released, keeping the camera consistent.
- "goal" is a short call to action shown on screen, e.g. "Drive through 5 rings" or "Escape the castle".
- Targets: 2-4 including the player character/vehicle (label "player").
- Favor visually dramatic, demo-worthy objectives achievable in under ~2 minutes.

${PLAN_RULES}

${RUBRIC_RULES}

Reply with ONLY a JSON object of this TypeScript type:
${LEVEL_TYPE}

Example level for a different idea:
${EXAMPLE_LEVEL}`;

const SCENE_SYSTEM = `You are the world designer for a game played inside LingBot World 2, a real-time image-to-video world model. It needs ONE opening image; the whole world grows from it.
${WORLD_RULES}

Given a theme, invent a playable scene and write a prompt for a text-to-image model that renders its OPENING FRAME:
- A cinematic 16:9 frame from a THIRD-PERSON video game: the camera is behind and slightly above ONE player character or vehicle, which is centred in the lower third and seen from behind. (Third person keeps the player visible, which helps the AI player and referee.)
- The challenge objects must be IN the frame, big, bright and distinctive (e.g. glowing rings, a towering gate, a giant golden key), with room to move toward them.
- Photorealistic or high-end game look, clear lighting, uncluttered composition, open traversable ground or water ahead. No text, no UI, no HUD, no watermark, no split panels.

Reply with ONLY JSON: {"title": "<2-4 words>", "idea": "<one sentence: the challenge>", "imagePrompt": "<the text-to-image prompt, 60-120 words>"}`;

const parseJson = (t: string) => JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));

export async function POST(request: Request) {
  let body: { mode?: "scratch" | "edit"; image?: string; theme?: string; generate?: boolean };
  try {
    body = await readJson(request, 9_000_000);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Invalid request", e instanceof HttpError ? e.status : 400);
  }
  const mode = body.mode === "edit" || (!body.mode && body.image) ? "edit" : "scratch";
  const theme = (body.theme ?? "").trim().slice(0, 500);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(280_000)]);
  const timings: Record<string, number> = {};
  const time = async <T,>(k: string, f: () => Promise<T>) => {
    const t = performance.now();
    try { return await f(); } finally { timings[k] = Math.round(performance.now() - t); }
  };

  try {
    let opening: string; //       servable path of the opening image
    let openingData: string; //   data URL Kimi looks at
    let note = "";
    let scene: { title?: string; idea?: string; imagePrompt?: string } = {};

    if (mode === "scratch") {
      if (!theme) return fail("Describe a theme for the new world.");
      if (!imageGenAvailable())
        return fail("LingBot needs an opening image: add REPLICATE_API_TOKEN to generate worlds from a theme, or start from an image.", 503);
      scene = parseJson(await time("scene", () => design(SCENE_SYSTEM, null, `Theme: ${theme}`, signal)));
      if (!scene.imagePrompt) throw new Error("World designer returned no image prompt");
      opening = await time("image", () => generateScene(String(scene.imagePrompt), null, signal));
      openingData = await toDataUrl(opening);
    } else {
      if (typeof body.image !== "string") return fail("Supply an image to start from.");
      opening = body.image;
      openingData = await toDataUrl(body.image);
    }

    const ask =
      mode === "scratch"
        ? `This is the generated OPENING FRAME of a new world. The intended challenge: ${scene.idea ?? theme}. Design the level around what is visible in this frame; do not add new objects. Reply with the JSON object only.`
        : `Design a level for this starting image.${
            theme ? ` Theme / idea from the user: ${theme}` : " Pick the most fun, visually dramatic challenge the scene supports."
          } Reply with the JSON object only.`;
    const raw = parseJson(await time("level", () => design(LEVEL_SYSTEM, openingData, ask, signal)));
    const level = validateLevel({
      ...raw,
      title: raw.title ?? scene.title,
      imagePrompt: mode === "scratch" ? scene.imagePrompt : raw.imagePrompt,
      id: `designed_${Date.now()}`,
      image: opening,
      author: designerModel(),
    });

    // Edit mode: put the level's new objects into the image.
    if (mode === "edit" && body.generate !== false) {
      if (!imageGenAvailable()) note = "No REPLICATE_API_TOKEN, so the original image is used unedited.";
      else if (level.imagePrompt) {
        try {
          level.image = await time("image", () => generateScene(level.imagePrompt!, openingData, signal));
        } catch (e) {
          note = `Image edit failed (${e instanceof Error ? e.message : e}); using the original image.`;
        }
      }
    }
    return NextResponse.json({ level, mode, timings, note }, { headers: NO_STORE });
  } catch (e) {
    return failFrom(e);
  }
}
