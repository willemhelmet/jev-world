"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLingbotWorld2, useLingbotWorld2Track } from "@reactor-models/lingbot-world-2/react";
import { composePrompt, type Action, type Level } from "@/lib/level";
import { drawFrame, resetOverlay, type Decision, type HudState } from "@/lib/overlay";

// Tuning knobs for the player loop.
const DONE_THRESHOLD = 0.7; // stage complete when done >= this ...
const DONE_STREAK = 2; // ... on this many consecutive ticks
const READY_THRESHOLD = 0.55; // interaction honoured only when ready >= this
const EVENT_MS = 5000; // how long the interaction "event" clause plays
const CONFIRM_MS = 16000; // give up on an unconfirmed interaction after this
const TICK_GAP_MS = 150; // pause between Jev calls
const STALE_MS = 4000; // release controls if a decision takes longer than this
const FRAME_W = 640; // JPEG width sent to Jev (keeps the short side >= 280px)

type Controls = { long: "idle" | "forward" | "back"; lat: "idle" | "strafe_left" | "strafe_right"; look: "idle" | "left" | "right" };
const IDLE: Controls = { long: "idle", lat: "idle", look: "idle" };
function controlsFor(a: Action): Controls {
  switch (a) {
    case "forward": return { ...IDLE, long: "forward" };
    case "back": return { ...IDLE, long: "back" };
    case "strafe_left": return { ...IDLE, lat: "strafe_left" };
    case "strafe_right": return { ...IDLE, lat: "strafe_right" };
    case "turn_left": return { ...IDLE, look: "left" };
    case "turn_right": return { ...IDLE, look: "right" };
    default: return IDLE;
  }
}

export function Arena({ level }: { level: Level }) {
  const lw2 = useLingbotWorld2();
  const track = useLingbotWorld2Track("main_video");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const grabRef = useRef<HTMLCanvasElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);

  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);
  const [running, setRunning] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ cost: 0, ticks: 0 });

  // Mutable game state read by the render loop and the player loop.
  const g = useRef({
    stage: 0,
    completed: 0,
    afters: [] as string[],
    pending: null as null | { since: number; after: string; label: string },
    doneStreak: 0,
    history: [] as { action: Action; ms: number }[],
    lastActionAt: 0,
    prevFrame: null as string | null,
    controls: IDLE,
    moving: false,
    lastPrompt: "",
    running: false,
    epoch: 0,
    hud: null as unknown as HudState,
  });
  g.current.hud ??= {
    level, stage: 0, completed: 0, decision: null, thinking: false,
    running: false, won: false, banner: null, log: [], ticks: 0, recording: false,
  };
  g.current.hud.level = level;

  const log = (line: string) => {
    const h = g.current.hud;
    h.log = [...h.log.slice(-20), line];
  };

  // ---- video → canvas render loop ----------------------------------------
  useEffect(() => {
    const v = videoRef.current;
    if (v && track) {
      v.srcObject = new MediaStream([track]);
      void v.play().catch(() => {});
    }
  }, [track]);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const c = canvasRef.current, v = videoRef.current;
      if (c) {
        const w = v?.videoWidth || 1248, h = v?.videoHeight || 720;
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        const ctx = c.getContext("2d");
        if (ctx) drawFrame(ctx, v, g.current.hud, performance.now());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- LingBot plumbing --------------------------------------------------
  const sendPrompt = useCallback(async (event?: string) => {
    const s = g.current;
    const p = composePrompt(level, s.moving, s.afters.concat(s.pending && !event ? [s.pending.after] : []), event);
    if (p === s.lastPrompt) return;
    s.lastPrompt = p;
    await lw2.setPrompt({ prompt: p }).catch(() => {});
  }, [level, lw2]);

  const applyControls = useCallback(async (next: Controls) => {
    const s = g.current, cur = s.controls;
    s.controls = next;
    const jobs: Promise<unknown>[] = [];
    if (next.long !== cur.long) jobs.push(lw2.setMoveLongitudinal({ move_longitudinal: next.long }));
    if (next.lat !== cur.lat) jobs.push(lw2.setMoveLateral({ move_lateral: next.lat }));
    if (next.look !== cur.look) jobs.push(lw2.setLookHorizontal({ look_horizontal: next.look }));
    await Promise.all(jobs).catch(() => {});
    const moving = next.long !== "idle" || next.lat !== "idle" || next.look !== "idle";
    if (moving !== s.moving && !s.pending) {
      s.moving = moving;
      await sendPrompt();
    } else s.moving = moving;
  }, [lw2, sendPrompt]);

  const loadLevel = useCallback(async () => {
    setLoading(true);
    setError(null);
    const s = g.current;
    s.running = false;
    setRunning(false);
    s.epoch++;
    Object.assign(s, { stage: 0, completed: 0, afters: [], pending: null, doneStreak: 0, history: [], prevFrame: null, controls: IDLE, moving: false, lastPrompt: "" });
    Object.assign(s.hud, { stage: 0, completed: 0, decision: null, won: false, banner: null, log: [], ticks: 0, thinking: false });
    resetOverlay();
    try {
      // Arena remounts per level, so always reset: a previous level may still be generating.
      await lw2.reset().catch(() => {});
      const blob = await (await fetch(level.image)).blob();
      const ref = await lw2.uploadFile(new File([blob], "start.jpg", { type: blob.type || "image/jpeg" }));
      if (!(await lw2.setImage({ image: ref }))) throw new Error("set_image was not accepted");
      s.lastPrompt = composePrompt(level, false, []);
      await lw2.setPrompt({ prompt: s.lastPrompt });
      await lw2.start();
      setStarted(true);
      log(`level loaded: ${level.title}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [level, lw2]);

  // Load automatically when the level changes while connected.
  useEffect(() => {
    if (lw2.status === "ready") void loadLevel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level.id, lw2.status === "ready"]);

  // ---- the player loop ---------------------------------------------------
  const grabFrame = (): string | null => {
    const v = videoRef.current;
    if (!v || v.readyState < 2 || !v.videoWidth) return null;
    const c = (grabRef.current ??= document.createElement("canvas"));
    c.width = FRAME_W;
    c.height = Math.round((v.videoHeight / v.videoWidth) * FRAME_W);
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.8).split(",")[1];
  };

  const completeStage = useCallback(async () => {
    const s = g.current;
    const st = level.stages[s.stage];
    if (s.pending) { s.afters.push(s.pending.after); s.pending = null; }
    s.completed = s.stage + 1;
    s.doneStreak = 0;
    s.hud.completed = s.completed;
    log(`✓ ${st.title}`);
    if (s.stage + 1 >= level.stages.length) {
      s.hud.won = true;
      s.running = false;
      setRunning(false);
      await applyControls(IDLE);
      await sendPrompt();
      return;
    }
    s.stage++;
    s.hud.stage = s.stage;
    s.hud.banner = { text: `✓ ${st.title.toUpperCase()}`, until: performance.now() + 2200 };
    await sendPrompt();
  }, [level, applyControls, sendPrompt]);

  const tick = useCallback(async (epoch: number) => {
    const s = g.current;
    if (!s.running || epoch !== s.epoch) return;
    const frame = grabFrame();
    if (!frame) { setTimeout(() => tick(epoch), 500); return; }
    const frames = s.prevFrame ? [s.prevFrame, frame] : [frame];
    s.prevFrame = frame;
    s.hud.thinking = true;
    const stale = setTimeout(() => { if (s.running) void applyControls(IDLE); }, STALE_MS);
    try {
      const res = await fetch("/api/jev", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          level: level.image.startsWith("data:") ? { ...level, image: "" } : level,
          stage: s.stage, frames, history: s.history, afters: s.afters,
          pending: s.pending?.label ?? null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Jev returned ${res.status}`);
      if (!s.running || epoch !== s.epoch) return;
      const d = data as Decision;
      s.hud.decision = d;
      s.hud.ticks++;
      setStats((p) => ({ cost: p.cost + (d.cost ?? 0), ticks: p.ticks + 1 }));

      const now = performance.now();
      if (s.history.length && s.lastActionAt) s.history[s.history.length - 1].ms = now - s.lastActionAt;
      const st = level.stages[s.stage];

      // 1. Stage completion
      s.doneStreak = (d.done ?? 0) >= DONE_THRESHOLD ? s.doneStreak + 1 : 0;
      if (s.doneStreak >= DONE_STREAK) { await completeStage(); if (!s.running) return; }

      // 2. Interaction lifecycle
      if (s.pending && now - s.pending.since > EVENT_MS && s.lastPrompt.includes(st.interaction?.event ?? "\u0000")) {
        await sendPrompt(); // event over → settle into the "after" world state
      }
      if (s.pending && now - s.pending.since > CONFIRM_MS) {
        log(`✗ "${s.pending.label}" not confirmed — retrying`);
        s.pending = null;
        await sendPrompt();
      }

      let action = d.action as Action;
      if (action === "interact") {
        if (!st.interaction || s.pending) action = "wait";
        else if ((d.ready ?? 0) < READY_THRESHOLD) {
          log(`interact refused: ready ${(d.ready ?? 0).toFixed(2)}`);
          action = "forward";
        } else {
          s.pending = { since: now, after: st.interaction.after, label: st.interaction.label };
          s.hud.banner = { text: `⚡ ${st.interaction.label.toUpperCase()}`, until: now + 2500 };
          log(`⚡ ${st.interaction.label} (ready ${(d.ready ?? 0).toFixed(2)})`);
          await applyControls(IDLE);
          await sendPrompt(st.interaction.event);
        }
      }
      if (s.pending) action = action === "interact" ? "interact" : "wait";

      // 3. Movement
      if (action !== "interact") await applyControls(controlsFor(action));
      const p = d.probabilities[d.action] ?? 0;
      log(`${String(d.action).padEnd(12)} p=${p.toFixed(2)} done=${(d.done ?? 0).toFixed(2)} ${d.latencyMs}ms`);
      s.history = [...s.history.slice(-5), { action, ms: 0 }];
      s.lastActionAt = now;
    } catch (e) {
      log(`error: ${e instanceof Error ? e.message.slice(0, 50) : e}`);
      await applyControls(IDLE);
      setError(e instanceof Error ? e.message : String(e));
      s.running = false;
      setRunning(false);
    } finally {
      clearTimeout(stale);
      s.hud.thinking = false;
    }
    if (s.running && epoch === s.epoch) setTimeout(() => tick(epoch), TICK_GAP_MS);
  }, [level, applyControls, completeStage, sendPrompt]);

  const toggleRun = () => {
    const s = g.current;
    s.running = !s.running;
    s.hud.running = s.running;
    setRunning(s.running);
    setError(null);
    if (s.running) { s.epoch++; void tick(s.epoch); log("autopilot on"); }
    else { void applyControls(IDLE); log("autopilot off"); }
  };

  // Manual driving when the autopilot is off — handy for scouting a level.
  useEffect(() => {
    const keymap: Record<string, Action> = {
      KeyW: "forward", KeyS: "back", KeyA: "strafe_left", KeyD: "strafe_right",
      ArrowLeft: "turn_left", ArrowRight: "turn_right",
    };
    const held = new Set<string>();
    const update = () => {
      if (g.current.running) return;
      const last = [...held].pop();
      void applyControls(last ? controlsFor(keymap[last]) : IDLE);
    };
    const down = (e: KeyboardEvent) => {
      if (!keymap[e.code] || (e.target as HTMLElement)?.closest("input,textarea")) return;
      e.preventDefault();
      if (!held.has(e.code)) { held.add(e.code); update(); }
    };
    const up = (e: KeyboardEvent) => { if (held.delete(e.code)) update(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [applyControls]);

  // ---- recording ---------------------------------------------------------
  const toggleRecord = () => {
    if (recorderRef.current) { recorderRef.current.stop(); return; }
    const c = canvasRef.current;
    if (!c) return;
    const type = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: type, videoBitsPerSecond: 12_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `jev-world-${level.id}-${Date.now()}.${rec.mimeType.includes("mp4") ? "mp4" : "webm"}`;
      a.click();
      recorderRef.current = null;
      g.current.hud.recording = false;
      setRecording(false);
    };
    rec.start(1000);
    recorderRef.current = rec;
    g.current.hud.recording = true;
    setRecording(true);
  };

  const ready = lw2.status === "ready";
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative w-full overflow-hidden rounded-xl border border-white/10 bg-black" style={{ aspectRatio: "1248 / 720" }}>
        <canvas ref={canvasRef} className="h-full w-full" />
        <video ref={videoRef} muted playsInline className="hidden" />
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-400">
            Connect to Reactor to start the world.
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={!ready || loading} onClick={loadLevel} className="btn">
          {loading ? "Loading…" : started ? "Restart level" : "Load level"}
        </button>
        <button disabled={!ready || !started || loading} onClick={toggleRun} className={`btn ${running ? "btn-hot" : "btn-primary"}`}>
          {running ? "Stop Jev" : "▶ Let Jev play"}
        </button>
        <button disabled={!ready} onClick={toggleRecord} className={`btn ${recording ? "btn-hot" : ""}`}>
          {recording ? "■ Stop & save video" : "● Record"}
        </button>
        <span className="ml-auto text-xs text-zinc-500">
          {stats.ticks} decisions · ${stats.cost.toFixed(4)} · WASD/←→ to drive manually when Jev is off
        </span>
      </div>
      {error && <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
    </div>
  );
}
