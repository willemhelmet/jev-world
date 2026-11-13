import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { NO_STORE, fail } from "@/lib/server/http";

export const runtime = "nodejs";

// Local-only: the arena posts each ● Record capture here so it lands in
// recordings/ next to the project (in addition to the browser download).
const DIR = path.join(process.cwd(), "recordings");
const MAX = 600 * 1024 * 1024;

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return fail("Origin not allowed", 403);
  const name = new URL(request.url).searchParams.get("name") ?? "";
  if (!/^[\w.-]+\.(mp4|webm)$/.test(name)) return fail("Bad file name");
  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.length > MAX) return fail("Bad recording size");
  if (!buf.length) return NextResponse.json({ path: `recordings/${name}`, bytes: 0 }, { headers: NO_STORE });
  await mkdir(DIR, { recursive: true });
  // ?append=1 streams a recording in 1s chunks while it is being made, so a
  // stuck MediaRecorder or a crashed tab can't lose the run.
  if (new URL(request.url).searchParams.get("append") === "1") await appendFile(path.join(DIR, name), buf);
  else await writeFile(path.join(DIR, name), buf);
  return NextResponse.json({ path: `recordings/${name}`, bytes: buf.length }, { headers: NO_STORE });
}
