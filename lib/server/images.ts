import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Scene image generation for the designer: edit the chosen starting image so
// the level's key objects are actually IN it (LingBot renders what's in the
// image far more reliably than what's only in the prompt).
//
// Replicate + google/nano-banana-pro by default (IMAGE_MODEL to override).

export const GENERATED_DIR = path.join(process.cwd(), ".data", "generated");
const MODEL = process.env.IMAGE_MODEL ?? "google/nano-banana-pro";

export function imageGenAvailable() {
  return !!process.env.REPLICATE_API_TOKEN?.trim();
}

/** Turn a public path or data URL into a data URL. Only /public images are readable. */
export async function toDataUrl(src: string): Promise<string> {
  if (src.startsWith("data:image/")) {
    if (src.length > 8_000_000) throw new Error("Image too large");
    return src;
  }
  const gen = /^\/api\/generated\/([\w-]+\.(?:png|jpe?g))$/.exec(src);
  const file = gen
    ? path.join(GENERATED_DIR, gen[1])
    : /^\/[\w\-/]+\.(jpe?g|png)$/i.test(src) && !src.includes("..")
      ? path.join(process.cwd(), "public", src)
      : null;
  if (!file) throw new Error("Bad image path");
  const buf = await readFile(file);
  return `data:${/\.png$/i.test(file) ? "image/png" : "image/jpeg"};base64,${buf.toString("base64")}`;
}

/**
 * Edit `baseImage` (data URL) according to `prompt`. Returns a servable path
 * like /api/generated/<id>.png.
 */
export async function generateScene(prompt: string, baseImage: string | null, signal?: AbortSignal) {
  const token = process.env.REPLICATE_API_TOKEN?.trim();
  if (!token) throw new Error("REPLICATE_API_TOKEN is not set");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "wait=60" };
  const input: Record<string, unknown> = {
    prompt,
    aspect_ratio: "16:9",
    resolution: "1K",
    output_format: "png",
    safety_filter_level: "block_only_high",
  };
  if (baseImage) input.image_input = [baseImage];
  let r = await (
    await fetch(`https://api.replicate.com/v1/models/${MODEL}/predictions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input }),
      signal,
    })
  ).json();
  const started = Date.now();
  while (!["succeeded", "failed", "canceled"].includes(r?.status)) {
    if (!r?.urls?.get) throw new Error(`Replicate: ${r?.detail ?? r?.error ?? "no prediction"}`);
    if (Date.now() - started > 150_000) throw new Error("Image generation timed out");
    await new Promise((res) => setTimeout(res, 2000));
    r = await (await fetch(r.urls.get, { headers, signal })).json();
  }
  if (r.status !== "succeeded") throw new Error(`Image generation ${r.status}: ${r.error ?? ""}`);
  const url = Array.isArray(r.output) ? r.output[0] : r.output;
  const bytes = Buffer.from(await (await fetch(url, { signal })).arrayBuffer());
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  await mkdir(GENERATED_DIR, { recursive: true });
  await writeFile(path.join(GENERATED_DIR, id), bytes);
  return `/api/generated/${id}`;
}
