// JWT resolver for <LingbotWorld2Provider jwtToken>. The server route
// app/api/reactor/token exchanges REACTOR_API_KEY for a short-lived,
// session-scoped JWT. Memoized here because a session can only be operated by
// the exact token that created it.

const REFRESH_SKEW_MS = 60_000;
let cached: { jwt: string; expiresAtMs: number } | null = null;
let inflight: Promise<string> | null = null;

export async function fetchToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAtMs - REFRESH_SKEW_MS) return cached.jwt;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch("/api/reactor/token", { cache: "no-store" });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Token fetch failed: ${r.status}`);
      }
      const { jwt, expires_at } = (await r.json()) as { jwt: string; expires_at: number };
      cached = { jwt, expiresAtMs: expires_at * 1000 };
      return jwt;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
