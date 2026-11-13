import { readFile } from "node:fs/promises";
import path from "node:path";
import { GENERATED_DIR } from "@/lib/server/images";

export const runtime = "nodejs";

// Serves designer-generated scene images from .data/generated.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[\w-]+\.(png|jpe?g)$/.test(id)) return new Response("Not found", { status: 404 });
  try {
    const buf = await readFile(path.join(GENERATED_DIR, id));
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": id.endsWith(".png") ? "image/png" : "image/jpeg",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
