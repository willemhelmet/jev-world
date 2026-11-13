import "server-only";
import { NextResponse } from "next/server";
import { ConfigError } from "./providers";

export const NO_STORE = { "Cache-Control": "private, no-store" };

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status, headers: NO_STORE });
}

export function failFrom(e: unknown) {
  if (e instanceof ConfigError) return fail(e.message, 503);
  console.error(e);
  return fail(e instanceof Error ? e.message : String(e), 502);
}

/** Same-origin JSON body with a size cap. These routes spend API keys: local use only. */
export async function readJson<T>(request: Request, maxBytes: number): Promise<T> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new HttpError("Origin not allowed", 403);
  const raw = await request.text();
  if (raw.length > maxBytes) throw new HttpError("Request too large", 413);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError("Invalid JSON");
  }
}

export class HttpError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function frames(v: unknown): string[] {
  const list = Array.isArray(v) ? v.slice(-2) : [];
  if (!list.length || list.some((f) => typeof f !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(f)))
    throw new HttpError("Supply one or two base64 JPEG frames");
  return list as string[];
}
