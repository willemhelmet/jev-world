"use client";

import { useEffect, useMemo, useState } from "react";
import { LingbotWorld2Provider, useLingbotWorld2 } from "@reactor-models/lingbot-world-2/react";
import { Arena, type ArenaStatus } from "@/components/Arena";
import { PlanGraph } from "@/components/PlanGraph";
import { validateLevel, type Level } from "@/lib/level";
import { BUILTIN_LEVELS } from "@/lib/levels";
import { fetchToken } from "@/lib/token";

const API_URL = process.env.NEXT_PUBLIC_REACTOR_API_URL ?? "https://api.reactor.inc";
const STORE_KEY = "jev-world:designed-levels:v2";
const SCENE_IMAGES = [
  { src: "/lingbot-cases/case1_0036.jpg", label: "Noir alley" },
  { src: "/lingbot-cases/case1_0038.jpg", label: "Battlefield" },
  { src: "/lingbot-cases/case2_1012.jpg", label: "Jet ski" },
];

function loadDesigned(): Level[] {
  try {
    return (JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as unknown[]).flatMap((l) => {
      try { return [validateLevel(l)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}
function saveDesigned(levels: Level[]) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(levels.slice(-12))); } catch { /* quota / private mode */ }
}

function Connection() {
  const { status, connect, disconnect, lastError } = useLingbotWorld2();
  const busy = status === "connecting" || status === "waiting";
  return (
    <div className="flex items-center gap-2">
      {status === "disconnected" && lastError && (
        <span className="max-w-md truncate text-xs text-red-300" title={lastError.message}>
          {lastError.message}
        </span>
      )}
      <span className={`h-2 w-2 rounded-full ${status === "ready" ? "bg-emerald-400" : busy ? "animate-pulse bg-amber-400" : "bg-zinc-600"}`} />
      <span className="text-xs text-zinc-400">{status}</span>
      {status === "disconnected" ? (
        <button className="btn btn-primary" onClick={() => connect()}>Connect</button>
      ) : (
        <button className="btn" onClick={() => disconnect()}>{busy ? "Cancel" : "Disconnect"}</button>
      )}
    </div>
  );
}

function Designer({ onDesigned }: { onDesigned: (l: Level) => void }) {
  const [mode, setMode] = useState<"scratch" | "edit">("scratch");
  const [image, setImage] = useState(SCENE_IMAGES[0].src);
  const [theme, setTheme] = useState("");
  const [generate, setGenerate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const upload = (file: File) => {
    const r = new FileReader();
    r.onload = () => typeof r.result === "string" && setImage(r.result);
    r.readAsDataURL(file);
  };

  const design = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "scratch" ? { mode, theme } : { mode, image, theme, generate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Designer returned ${res.status}`);
      onDesigned(validateLevel(data.level));
      const t = data.timings ?? {};
      const secs = (ms?: number) => (ms ? `${(ms / 1000).toFixed(0)}s` : null);
      setNote(
        [secs(t.scene) && `scene ${secs(t.scene)}`, secs(t.image) && `image ${secs(t.image)}`, secs(t.level) && `level ${secs(t.level)}`]
          .filter(Boolean)
          .join(" · ") + (data.note ? `. ${data.note}` : ""),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const tab = (m: typeof mode, label: string) => (
    <button onClick={() => setMode(m)}
      className={`flex-1 rounded px-2 py-1 text-[11px] ${mode === m ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}>
      {label}
    </button>
  );

  return (
    <section className="space-y-2">
      <h3 className="label">Level designer agent</h3>
      <div className="flex gap-1 rounded-md border border-white/10 p-0.5">
        {tab("scratch", "✦ New world")}
        {tab("edit", "From image")}
      </div>
      {mode === "edit" && (
        <div className="grid grid-cols-4 gap-1.5">
          {SCENE_IMAGES.map((s) => (
            <button key={s.src} onClick={() => setImage(s.src)} title={s.label}
              className={`overflow-hidden rounded-md border ${image === s.src ? "border-emerald-400" : "border-white/10"}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.src} alt={s.label} className="aspect-video w-full object-cover" />
            </button>
          ))}
          <label className={`flex cursor-pointer items-center justify-center rounded-md border text-[10px] text-zinc-400 ${image.startsWith("data:") ? "border-emerald-400" : "border-dashed border-white/15"}`}>
            {image.startsWith("data:") ? "custom ✓" : "+ image"}
            <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </label>
        </div>
      )}
      <textarea value={theme} onChange={(e) => setTheme(e.target.value)} rows={2}
        placeholder={mode === "scratch"
          ? "Theme: e.g. escape a burning castle on horseback, or race a hovercar through neon canyon gates"
          : "Idea (optional): e.g. light three signal flares, or steal the general's banner"}
        className="w-full resize-none rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-400/60 focus:outline-none" />
      {mode === "edit" && (
        <label className="flex items-center gap-2 text-[11px] text-zinc-400">
          <input type="checkbox" checked={generate} onChange={(e) => setGenerate(e.target.checked)} />
          Edit the image to add the level&apos;s objects
        </label>
      )}
      <button className="btn w-full" disabled={busy || (mode === "scratch" && !theme.trim())} onClick={design}>
        {busy ? (mode === "scratch" ? "Writing scene → rendering → designing…" : "Designing…") : mode === "scratch" ? "✦ Generate a world" : "✦ Design a level"}
      </button>
      {note && <p className="text-[11px] text-zinc-500">{note}</p>}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </section>
  );
}

function Main() {
  const [designed, setDesigned] = useState<Level[]>([]);
  const [levelId, setLevelId] = useState(BUILTIN_LEVELS[0].id);
  const [showJson, setShowJson] = useState(false);
  const [status, setStatus] = useState<ArenaStatus | null>(null);
  useEffect(() => setDesigned(loadDesigned()), []);

  const levels = useMemo(() => [...BUILTIN_LEVELS, ...designed], [designed]);
  const level = levels.find((l) => l.id === levelId) ?? levels[0];

  const addDesigned = (l: Level) => {
    const next = [...designed, l];
    setDesigned(next);
    saveDesigned(next);
    setLevelId(l.id);
  };
  const removeDesigned = (id: string) => {
    const next = designed.filter((l) => l.id !== id);
    setDesigned(next);
    saveDesigned(next);
    if (levelId === id) setLevelId(BUILTIN_LEVELS[0].id);
  };

  return (
    <div className="flex min-h-0 flex-1 gap-4 p-4">
      <aside className="flex w-80 shrink-0 flex-col gap-5 overflow-y-auto">
        <section className="space-y-1.5">
          <h3 className="label">Levels</h3>
          {levels.map((l) => (
            <div key={l.id} className={`group flex items-start gap-2 rounded-lg border px-3 py-2 ${l.id === level.id ? "border-emerald-400/60 bg-emerald-400/[0.06]" : "border-white/10 hover:border-white/20"}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={l.image} alt="" className="mt-0.5 h-10 w-16 shrink-0 rounded object-cover" />
              <button className="min-w-0 flex-1 text-left" onClick={() => { setStatus(null); setLevelId(l.id); }}>
                <div className="text-sm font-medium text-zinc-100">{l.title}</div>
                <div className="mt-0.5 line-clamp-2 text-[11px] text-zinc-500">{l.goal}</div>
                <div className="mt-1 text-[10px] uppercase tracking-wider text-zinc-600">{l.author}</div>
              </button>
              {l.author !== "handmade" && (
                <button onClick={() => removeDesigned(l.id)} className="text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-red-300" title="Delete">×</button>
              )}
            </div>
          ))}
        </section>
        <PlanGraph plan={status?.plan ?? level.plan} current={status?.current ?? level.plan.start} />
        <Designer onDesigned={addDesigned} />
        <section className="space-y-1.5">
          <button className="label hover:text-zinc-300" onClick={() => setShowJson((v) => !v)}>
            {showJson ? "▾" : "▸"} Level JSON
          </button>
          {showJson && (
            <pre className="max-h-96 overflow-auto rounded-md border border-white/10 bg-black/40 p-2 text-[10px] leading-relaxed text-zinc-400">
              {JSON.stringify({ ...level, image: level.image.startsWith("data:") ? "(uploaded image)" : level.image }, null, 2)}
            </pre>
          )}
        </section>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <Arena key={level.id} level={level} onStatus={setStatus} />
      </main>
    </div>
  );
}

export function JevWorldApp() {
  return (
    <LingbotWorld2Provider apiUrl={API_URL} jwtToken={fetchToken}>
      <div className="flex h-screen flex-col overflow-hidden bg-zinc-950">
        <header className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
          <div className="flex items-baseline gap-3">
            <h1 className="text-sm font-semibold tracking-tight text-zinc-100">Jev World</h1>
            <span className="hidden text-[11px] uppercase tracking-wider text-zinc-500 sm:inline">
              a decision model plays a world model
            </span>
          </div>
          <Connection />
        </header>
        <Main />
      </div>
    </LingbotWorld2Provider>
  );
}
