import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { validateLevel } from "@/lib/level";
import { BUILTIN_LEVELS } from "@/lib/levels";
import { ConfigError, DESIGNER_MODEL, chat } from "@/lib/server/openrouter";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };

// The level designer agent. Given a starting image and a loose theme, it
// writes a Level (see lib/level.ts): the world prompt for LingBot World 2,
// the targets to track, and staged objectives with strict visual checks
// that Jev will judge.

const SYSTEM = `You design short game levels that are played inside LingBot World 2, a real-time image-to-video world model, by an AI player called Jev.

How the world works:
- LingBot starts from a single image and a text prompt and streams video. The player can move forward/back, strafe, and turn. There is NO game engine: objects exist only because the prompt and image describe them.
- Interactions (pick up, open, ignite, ...) are implemented by temporarily adding an "event" clause to the prompt, then keeping an "after" clause describing the new world state. Whether it worked is judged visually by Jev.
- Jev answers yes/no questions about frames, picks the next control, and draws bounding boxes around targets.

Design rules:
- Build on what is ACTUALLY in the image. You may add 1-2 new objects, described in prompt.base with "EXACTLY ONE ... at a fixed position" phrasing and vivid, distinctive visual features (color, glow, size) so the video model keeps them stable.
- prompt.base must restate the subject, viewpoint, environment and style of the image. prompt.moving / prompt.still describe the subject's motion while controls are held / released, keeping the camera consistent.
- 1-3 stages, ordered. Each stage has one target. Navigation stages ("reach X") have no interaction. Interaction stages have "ready" (target within reach right now) and an interaction.
- "done" and "ready" are strict yes/no questions about the LAST image. Start with "In the LAST image, ...". Say what does NOT qualify (distant object, object merely visible, ambiguous view).
- Targets: 2-4, including the player character/vehicle (label "player"). "describe" is a concrete visual description usable for a bounding box.
- Keep it achievable within ~60 seconds of play. Favor visually dramatic outcomes (doors opening, lights turning on, fires, explosions of confetti) that make a good demo.

Reply with ONLY a JSON object matching this TypeScript type:
type Level = {
  id: string; title: string; brief: string; viewpoint: string;
  prompt: { base: string; moving: string; still: string };
  targets: { id: string; label: string; describe: string }[];
  stages: { id: string; title: string; target: string; done: string;
            ready?: string; interaction?: { label: string; event: string; after: string } }[];
};

Here is an example level for a different image:
${JSON.stringify({ ...BUILTIN_LEVELS[0], image: undefined, author: undefined })}`;

async function loadImage(src: string): Promise<string> {
  if (src.startsWith("data:image/")) {
    if (src.length > 4_000_000) throw new Error("Image too large");
    return src;
  }
  // Only images shipped in /public are readable.
  const rel = path.normalize(src).replace(/^(\.\.(\/|\\|$))+/, "");
  if (!/^\/?[\w\-/]+\.(jpe?g|png)$/i.test(rel)) throw new Error("Bad image path");
  const file = path.join(process.cwd(), "public", rel);
  const buf = await readFile(file);
  const mime = /\.png$/i.test(file) ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return NextResponse.json({ error: "Origin not allowed" }, { status: 403, headers });
  try {
    const { image, theme } = (await request.json()) as { image?: string; theme?: string };
    if (typeof image !== "string") throw new Error("Supply an image");
    const dataUrl = await loadImage(image);
    const content = await chat([
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          {
            type: "text",
            text: `Design a level for this starting image.${
              theme?.trim() ? ` Theme / idea from the user: ${theme.trim().slice(0, 500)}` : " Pick the most fun, visually dramatic challenge the scene supports."
            }`,
          },
        ],
      },
    ]);
    const json = content.replace(/^```(?:json)?\s*|\s*```$/g, "");
    const level = validateLevel({
      ...JSON.parse(json),
      id: `designed_${Date.now()}`,
      image,
      author: DESIGNER_MODEL,
    });
    return NextResponse.json({ level }, { headers });
  } catch (e) {
    const status = e instanceof ConfigError ? 503 : 502;
    console.error(e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Design failed" },
      { status, headers },
    );
  }
}
