"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLingbotWorld2, useLingbotWorld2Track } from "@reactor-models/lingbot-world-2/react";
import { composePrompt, type Action, type Level, type Plan, type PlanNode } from "@/lib/level";
import { drawFrame, resetOverlay, type HudState, type PlayerDecision } from "@/lib/overlay";

// Three loops share one frame sampler:
//   PLAYER   every tick: which plan state am I in? → steer / search / act / interact
//   REFEREE  ~every 0.7s: independent Jev scores events from two frames 1s apart
//   PLANNER  only when stuck: an LLM rewrites the plan graph from the current frame

// ---- tuning -----------------------------------------------------------------
const FRAME_W = 640; //            JPEG width sent to Jev (short side stays >= 280px)
const SAMPLE_MS = 250; //          frame sampler period
const TICK_GAP_MS = 150; //        minimum pause between player calls
const MIN_HOLD_MS = 1200; //       hold discrete moves at least this long (Jev is faster than LingBot)
const STEER_HOLD_MS = 650; //      steering corrections can be shorter
const STEER_DEADBAND = 0.08; //    |box center - 0.5| below this = go straight
const SEEN = 0.5; //               target visibility threshold
const STATE_SWITCH = 0.45; //      switch to a neighbouring state at this confidence…
const STATE_JUMP = 0.7; //         …or to any state at this one
const REFEREE_GAP_MS = 400; //     pause between referee calls
const REFEREE_SPAN_MS = 1000; //   referee compares frames this far apart
const SCORE_P = 0.7; //            referee event fires at this probability
const EVENT_MS = 5000; //          interaction "event" clause duration
const STUCK_MS = 15000; //         replan after this long in one state without scoring
const REPLAN_COOLDOWN_MS = 25000;
const STALE_MS = 4000; //          release controls if a decision takes longer
const EVIDENCE_MS = 2500; //       referee points need player box evidence from this window
const EVIDENCE_CENTER = 0.3; //    …with the target's centre within ±this of frame centre

type Controls = { long: "idle" | "forward" | "back"; lat: "idle" | "strafe_left" | "strafe_right"; look: "idle" | "left" | "right" };
const IDLE: Controls = { long: "idle", lat: "idle", look: "idle" };
const isMoving = (c: Controls) => c.long !== "idle" || c.lat !== "idle" || c.look !== "idle";
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
function describe(c: Controls) {
  const parts = [
    c.long === "forward" ? "W" : c.long === "back" ? "S" : "",
    c.lat === "strafe_left" ? "A" : c.lat === "strafe_right" ? "D" : "",
    c.look === "left" ? "←" : c.look === "right" ? "→" : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" + ") : "idle";
}

// LingBot is picky about its opening image: every image that worked was a
// ~1248px-wide JPEG, and a 1376x768 PNG from the image model was rejected.
// Normalise whatever the level uses (stock, generated, uploaded) to that.
const OPENING_W = 1248;
async function openingJpeg(src: string): Promise<Blob> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = OPENING_W;
  c.height = Math.round((img.naturalHeight / img.naturalWidth) * OPENING_W / 8) * 8;
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Could not encode opening image"))), "image/jpeg", 0.92));
}

export type ArenaStatus = { plan: Plan; current: string; score: number; outcome: HudState["outcome"] };

export function Arena({ level, onStatus }: { level: Level; onStatus?: (s: ArenaStatus) => void }) {
  const lw2 = useLingbotWorld2();
  const track = useLingbotWorld2Track("main_video");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const grabRef = useRef<HTMLCanvasElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);
  const [running, setRunning] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticks, setTicks] = useState(0);
  const [, force] = useState(0);

  const freshHud = (): HudState => ({
    level, plan: level.plan, current: level.plan.start, control: "", decision: null, referee: {},
    refereeMs: 0, score: 0, startedAt: null, endedAt: null, outcome: null, replanning: false,
    banner: null, toasts: [], log: [], ticks: 0, recording: false,
  });
  // All mutable game state lives here; the render loop reads `hud`.
  const g = useRef({
    epoch: 0,
    running: false,
    frames: [] as { t: number; data: string }[],
    controls: IDLE,
    moving: false,
    lastPrompt: "",
    afters: [] as string[],
    pendingEvent: null as null | { until: number; after: string },
    fired: new Set<string>(), //            interact states already triggered
    scored: new Map<string, number>(), //   referee event id -> last fired time
    nodeSince: 0,
    lastScoreAt: 0,
    lastReplanAt: 0,
    lastSeenSide: {} as Record<string, "left" | "right">,
    history: [] as { action: string; state: string }[],
    boxLog: [] as { t: number; boxes: PlayerDecision["boxes"] }[], // evidence for the referee gate
    rejectedAt: new Map<string, number>(),
    hud: null as unknown as HudState,
  });
  g.current.hud ??= freshHud();

  const hud = () => g.current.hud;
  const log = (line: string) => { hud().log = [...hud().log.slice(-20), line]; };
  const publish = () => {
    const h = hud();
    onStatusRef.current?.({ plan: h.plan, current: h.current, score: h.score, outcome: h.outcome });
  };
  const nodeOf = (id: string): PlanNode => hud().plan.nodes.find((n) => n.id === id) ?? hud().plan.nodes[0];
  const levelForApi = () => (level.image.startsWith("data:") ? { ...level, image: "" } : level);

  // ---- video → canvas --------------------------------------------------------
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
        const w = v?.videoWidth || 1664, h = v?.videoHeight || 960;
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        const ctx = c.getContext("2d");
        if (ctx) drawFrame(ctx, v, g.current.hud, performance.now());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- frame sampler (shared by player, referee, planner) -------------------
  const grab = (): string | null => {
    const v = videoRef.current;
    if (!v || v.readyState < 2 || !v.videoWidth) return null;
    const c = (grabRef.current ??= document.createElement("canvas"));
    c.width = FRAME_W;
    c.height = Math.round((v.videoHeight / v.videoWidth) * FRAME_W);
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.8).split(",")[1];
  };
  useEffect(() => {
    const id = setInterval(() => {
      if (!g.current.running) return;
      const data = grab();
      if (!data) return;
      const now = performance.now();
      g.current.frames = [...g.current.frames.filter((f) => now - f.t < 3000), { t: now, data }];
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, []);
  const latest = () => g.current.frames.at(-1) ?? null;
  const frameAgo = (ms: number) => {
    const t = performance.now() - ms;
    const fs = g.current.frames;
    return fs.find((f) => f.t >= t) ?? fs[0] ?? null;
  };

  // ---- LingBot plumbing --------------------------------------------------------
  const sendPrompt = useCallback(async (event?: string) => {
    const s = g.current;
    const p = composePrompt(level, s.moving, s.afters, event);
    if (p === s.lastPrompt) return;
    s.lastPrompt = p;
    await lw2.setPrompt({ prompt: p }).catch(() => {});
  }, [level, lw2]);

  const applyControls = useCallback(async (next: Controls) => {
    const s = g.current, cur = s.controls;
    s.controls = next;
    g.current.hud.control = describe(next);
    const jobs: Promise<unknown>[] = [];
    if (next.long !== cur.long) jobs.push(lw2.setMoveLongitudinal({ move_longitudinal: next.long }));
    if (next.lat !== cur.lat) jobs.push(lw2.setMoveLateral({ move_lateral: next.lat }));
    if (next.look !== cur.look) jobs.push(lw2.setLookHorizontal({ look_horizontal: next.look }));
    await Promise.all(jobs).catch(() => {});
    const moving = isMoving(next);
    const changed = moving !== s.moving;
    s.moving = moving;
    if (changed && !s.pendingEvent) await sendPrompt();
  }, [lw2, sendPrompt]);

  const stopAll = useCallback(async (outcome?: HudState["outcome"]) => {
    const s = g.current;
    s.running = false;
    setRunning(false);
    if (outcome) {
      s.hud.outcome = outcome;
      s.hud.endedAt = performance.now();
      log(outcome === "won" ? "🏁 level complete" : "⏱ time up");
      publish();
    } else if (s.hud.startedAt) {
      s.hud.endedAt = performance.now(); // pause the clock
    }
    await applyControls(IDLE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyControls]);

  const loadLevel = useCallback(async () => {
    setLoading(true);
    setError(null);
    const s = g.current;
    s.running = false;
    setRunning(false);
    s.epoch++;
    Object.assign(s, {
      frames: [], controls: IDLE, moving: false, lastPrompt: "", afters: [], pendingEvent: null,
      fired: new Set(), scored: new Map(), nodeSince: 0, lastScoreAt: 0, lastReplanAt: 0, lastSeenSide: {}, history: [],
      boxLog: [], rejectedAt: new Map(),
    });
    s.hud = { ...freshHud(), recording: !!recorderRef.current };
    resetOverlay();
    publish();
    setTicks(0);
    try {
      await lw2.reset().catch(() => {}); // Arena remounts per level; a previous one may still be generating
      const blob = await openingJpeg(level.image);
      const ref = await lw2.uploadFile(new File([blob], "start.jpg", { type: "image/jpeg" }));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, lw2]);

  // If the world drops, stop the agents: otherwise they keep deciding (and the
  // planner keeps replanning) against a black screen.
  useEffect(() => {
    if (lw2.status !== "ready" && g.current.running) {
      void stopAll();
      log(`world ${lw2.status}: agents paused`);
      setError(`Reactor session ${lw2.status}. Agents paused; reconnect and restart the level.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lw2.status]);

  useEffect(() => {
    if (lw2.status === "ready") void loadLevel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level.id, lw2.status === "ready"]);

  // ---- PLAYER: plan state → controls ---------------------------------------
  const decideControls = (node: PlanNode, d: PlayerDecision): { controls: Controls; hold: number; label: string } => {
    const s = g.current;
    for (const [id, b] of Object.entries(d.boxes))
      if ((b.seen ?? 0) >= SEEN) s.lastSeenSide[id] = (b.box.left + b.box.right) / 2 < 0.5 ? "left" : "right";
    const searchFor = (target: string) => {
      const side = s.lastSeenSide[target] ?? "right";
      return { controls: { ...IDLE, look: side }, hold: MIN_HOLD_MS, label: `search ${side}` };
    };
    const steerTo = (target: string) => {
      const b = d.boxes[target];
      if (!b || (b.seen ?? 0) < SEEN) return searchFor(target);
      const err = (b.box.left + b.box.right) / 2 - 0.5;
      const look: Controls["look"] = err > STEER_DEADBAND ? "right" : err < -STEER_DEADBAND ? "left" : "idle";
      return {
        controls: { ...IDLE, long: "forward" as const, look },
        hold: look === "idle" ? MIN_HOLD_MS : STEER_HOLD_MS,
        label: `steer ${err >= 0 ? "+" : ""}${err.toFixed(2)}`,
      };
    };
    switch (node.mode) {
      case "search": {
        const b = node.target ? d.boxes[node.target] : undefined;
        if (b && (b.seen ?? 0) >= SEEN) return steerTo(node.target!); // spotted: start approaching
        return searchFor(node.target!);
      }
      case "steer":
        return steerTo(node.target!);
      case "interact":
        return { controls: IDLE, hold: TICK_GAP_MS, label: "interact" };
      default: {
        const allowed = node.actions?.length ? node.actions : (["forward", "wait"] as Action[]);
        const probs = d.action?.probabilities ?? {};
        const best = allowed.reduce((a, b) => ((probs[b] ?? 0) > (probs[a] ?? 0) ? b : a), allowed[0]);
        return { controls: controlsFor(best), hold: MIN_HOLD_MS, label: best };
      }
    }
  };

  // ---- PLANNER ------------------------------------------------------------------
  const replan = useCallback(async (epoch: number, why: string) => {
    const s = g.current, h = s.hud;
    const cur = latest() ?? (() => { const d = grab(); return d ? { t: 0, data: d } : null; })();
    if (!cur || h.replanning) return;
    h.replanning = true;
    force((x) => x + 1);
    s.lastReplanAt = performance.now();
    h.banner = { text: "🧠 REPLANNING", until: performance.now() + 2000, color: "#5ab8ff" };
    log(`planner: ${why}, replanning…`);
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          level: levelForApi(), plan: h.plan, current: h.current, frames: [cur.data],
          history: s.history, score: h.score, stuckS: (performance.now() - s.nodeSince) / 1000,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Planner returned ${res.status}`);
      if (epoch !== s.epoch) return;
      h.plan = data.plan as Plan;
      if (!h.plan.nodes.some((n) => n.id === h.current)) h.current = h.plan.start;
      s.nodeSince = performance.now();
      h.banner = { text: "🧠 NEW PLAN", until: performance.now() + 2200, color: "#5ab8ff" };
      log(`plan: ${String(data.reason || "revised").slice(0, 46)} (${(data.latencyMs / 1000).toFixed(1)}s)`);
      publish();
    } catch (e) {
      log(`planner error: ${e instanceof Error ? e.message.slice(0, 40) : e}`);
    } finally {
      h.replanning = false;
      force((x) => x + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level]);

  // ---- PLAYER loop ------------------------------------------------------------
  const playerTick = useCallback(async (epoch: number) => {
    const s = g.current;
    if (!s.running || epoch !== s.epoch) return;
    const cur = latest();
    if (!cur) { setTimeout(() => playerTick(epoch), 300); return; }
    const prev = frameAgo(800);
    const h = s.hud;
    const stale = setTimeout(() => { if (s.running) void applyControls(IDLE); }, STALE_MS);
    let wait = TICK_GAP_MS;
    try {
      const res = await fetch("/api/jev", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          level: levelForApi(), plan: h.plan, current: h.current,
          frames: prev && prev !== cur ? [prev.data, cur.data] : [cur.data],
          history: s.history, afters: s.afters,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Player returned ${res.status}`);
      if (!s.running || epoch !== s.epoch) return;
      const d = data as PlayerDecision;
      h.decision = d;
      s.boxLog = [...s.boxLog.filter((b) => performance.now() - b.t < 4000), { t: performance.now(), boxes: d.boxes }];
      h.ticks++;
      setTicks(h.ticks);
      const now = performance.now();

      // 1. Where are we in the plan? Neighbours switch easily, jumps need confidence.
      const node = nodeOf(h.current);
      const chosen = d.state?.choice;
      const p = chosen ? (d.state?.probabilities[chosen] ?? 0) : 0;
      if (chosen && chosen !== h.current && h.plan.nodes.some((n) => n.id === chosen)) {
        if ((node.next.includes(chosen) && p >= STATE_SWITCH) || p >= STATE_JUMP) {
          log(`→ ${nodeOf(chosen).label} (${Math.round(p * 100)}%)`);
          h.current = chosen;
          s.nodeSince = now;
          publish();
        }
      }
      const active = nodeOf(h.current);

      // 2. Interactions fire once, on arrival in an interact state.
      if (active.mode === "interact" && active.interaction && !s.fired.has(active.id) && !s.pendingEvent) {
        s.fired.add(active.id);
        h.banner = { text: `⚡ ${active.interaction.label.toUpperCase()}`, until: now + 2500 };
        log(`⚡ ${active.interaction.label}`);
        await applyControls(IDLE);
        s.pendingEvent = { until: now + EVENT_MS, after: active.interaction.after };
        await sendPrompt(active.interaction.event);
      }
      if (s.pendingEvent && now > s.pendingEvent.until) {
        s.afters.push(s.pendingEvent.after);
        s.pendingEvent = null;
        await sendPrompt();
      }

      // 3. Drive.
      if (!s.pendingEvent) {
        const out = decideControls(active, d);
        await applyControls(out.controls);
        wait = isMoving(out.controls) ? Math.max(TICK_GAP_MS, out.hold - d.latencyMs) : TICK_GAP_MS;
        s.history = [...s.history.slice(-11), { state: active.id, action: out.label }];
        log(`${active.id.slice(0, 10).padEnd(10)} ${out.label.padEnd(14)} ${d.latencyMs}ms`);
      }

      // 4. Stuck? Ask the planner, in the background.
      if (now - s.nodeSince > STUCK_MS && now - s.lastScoreAt > STUCK_MS && now - s.lastReplanAt > REPLAN_COOLDOWN_MS && !h.replanning)
        void replan(epoch, "stuck");

      // 5. Out of time?
      const limit = level.rubric.timeLimitS;
      if (limit && h.startedAt && now - h.startedAt > limit * 1000) { await stopAll("time"); return; }
    } catch (e) {
      log(`player error: ${e instanceof Error ? e.message.slice(0, 40) : e}`);
      setError(e instanceof Error ? e.message : String(e));
      await stopAll();
      return;
    } finally {
      clearTimeout(stale);
    }
    if (s.running && epoch === s.epoch) setTimeout(() => playerTick(epoch), wait);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, applyControls, sendPrompt, stopAll, replan]);

  // ---- REFEREE loop -----------------------------------------------------------
  const refereeTick = useCallback(async (epoch: number) => {
    const s = g.current;
    if (!s.running || epoch !== s.epoch) return;
    const cur = latest(), before = frameAgo(REFEREE_SPAN_MS);
    const h = s.hud;
    const t0 = performance.now();
    const open = level.rubric.events
      .filter((e) => (e.repeat ? t0 - (s.scored.get(e.id) ?? -1e9) > (e.cooldownS ?? 4) * 1000 : !s.scored.has(e.id)))
      .map((e) => e.id);
    if (cur && before && before !== cur && open.length) {
      try {
        const res = await fetch("/api/referee", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ level: levelForApi(), frames: [before.data, cur.data], open }),
        });
        const data = await res.json();
        if (!res.ok) log(`referee error: ${String(data.error).slice(0, 40)}`);
        else if (s.running && epoch === s.epoch) {
          h.referee = { ...h.referee, ...data.events };
          h.refereeMs = data.latencyMs;
          const now = performance.now();
          for (const e of level.rubric.events) {
            const p = data.events?.[e.id];
            if (p == null || p < SCORE_P || !open.includes(e.id)) continue;
            // Evidence gate: did the player actually have this target big and centred just now?
            if (e.evidence) {
              const ev = e.evidence;
              const ok = s.boxLog.some(({ t, boxes }) => {
                const b = boxes[ev.target];
                if (now - t > EVIDENCE_MS || !b || (b.seen ?? 0) < SEEN) return false;
                const size = b.box.bottom - b.box.top;
                const cx = (b.box.left + b.box.right) / 2;
                return size >= ev.minSize && Math.abs(cx - 0.5) <= EVIDENCE_CENTER;
              });
              if (!ok) {
                if (now - (s.rejectedAt.get(e.id) ?? 0) > 2000) log(`✗ ${e.label} vetoed (${Math.round(p * 100)}%): no close ${ev.target} seen`);
                s.rejectedAt.set(e.id, now);
                continue;
              }
            }
            s.scored.set(e.id, now);
            s.lastScoreAt = now;
            h.score += e.points;
            h.toasts = [...h.toasts.filter((t) => now - t.at < 1500), { text: `+${e.points} ${e.label}`, at: now }];
            log(`★ +${e.points} ${e.label} (${Math.round(p * 100)}%) → ${h.score}`);
            publish();
            const r = level.rubric;
            if ((r.winEvent && e.id === r.winEvent) || (r.winPoints && h.score >= r.winPoints)) {
              await stopAll("won");
              return;
            }
          }
        }
      } catch (e) {
        log(`referee error: ${e instanceof Error ? e.message.slice(0, 40) : e}`);
      }
    }
    if (s.running && epoch === s.epoch) setTimeout(() => refereeTick(epoch), REFEREE_GAP_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, stopAll]);

  // ---- buttons ------------------------------------------------------------------
  const toggleRun = () => {
    const s = g.current, h = s.hud;
    if (s.running) { void stopAll(); log("agents paused"); return; }
    if (h.outcome) return;
    s.running = true;
    setRunning(true);
    setError(null);
    s.epoch++;
    const now = performance.now();
    if (!h.startedAt) h.startedAt = now;
    else if (h.endedAt) { h.startedAt += now - h.endedAt; h.endedAt = null; }
    s.nodeSince = now;
    s.lastScoreAt = now;
    s.frames = [];
    log("agents on: player + referee");
    void playerTick(s.epoch);
    void refereeTick(s.epoch);
  };

  // Manual driving when the agents are paused — handy for scouting a level.
  useEffect(() => {
    const keymap: Record<string, Action> = {
      KeyW: "forward", KeyS: "back", KeyA: "strafe_left", KeyD: "strafe_right", ArrowLeft: "turn_left", ArrowRight: "turn_right",
    };
    const held = new Set<string>();
    const update = () => {
      if (g.current.running) return;
      const c: Controls = { ...IDLE };
      for (const k of held) {
        const x = controlsFor(keymap[k]);
        if (x.long !== "idle") c.long = x.long;
        if (x.lat !== "idle") c.lat = x.lat;
        if (x.look !== "idle") c.look = x.look;
      }
      void applyControls(c);
    };
    const down = (e: KeyboardEvent) => {
      if (!keymap[e.code] || (e.target instanceof Element && e.target.closest("input,textarea"))) return;
      e.preventDefault();
      if (!held.has(e.code)) { held.add(e.code); update(); }
    };
    const up = (e: KeyboardEvent) => { if (held.delete(e.code)) update(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [applyControls]);

  const toggleRecord = () => {
    const finish = () => {
      recorderRef.current = null;
      g.current.hud.recording = false;
      setRecording(false);
    };
    const live = recorderRef.current;
    if (live) {
      if (live.state === "inactive") finish();
      else {
        live.stop();
        setTimeout(() => recorderRef.current === live && finish(), 4000); // never leave the UI stuck
      }
      return;
    }
    const c = canvasRef.current;
    if (!c) return;
    const type = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: type, videoBitsPerSecond: 10_000_000 });
    const name = `jev-world-${level.id}-${Date.now()}.${rec.mimeType.includes("mp4") ? "mp4" : "webm"}`;
    const chunks: Blob[] = [];
    // Stream each chunk to recordings/ as it arrives (in order), so the file
    // exists on disk even if the recorder never fires "stop".
    let upload = Promise.resolve();
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      chunks.push(e.data);
      const part = e.data;
      upload = upload.then(() =>
        fetch(`/api/recordings?name=${name}&append=1`, { method: "POST", body: part }).then(() => undefined, () => undefined),
      );
    };
    rec.onstop = () => {
      void upload.then(() => log(`saved recordings/${name}`));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType }));
      a.download = name;
      a.click();
      finish();
    };
    rec.start(1000);
    recorderRef.current = rec;
    g.current.hud.recording = true;
    setRecording(true);
    log(`recording → recordings/${name}`);
  };

  const ready = lw2.status === "ready";
  const over = !!g.current.hud.outcome;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative w-full overflow-hidden rounded-xl border border-white/10 bg-black" style={{ aspectRatio: "1664 / 960" }}>
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
        <button disabled={!ready || !started || loading || over} onClick={toggleRun} className={`btn ${running ? "btn-hot" : "btn-primary"}`}>
          {running ? "Pause agents" : "▶ Let Jev play"}
        </button>
        <button disabled={!ready || !started || g.current.hud.replanning} onClick={() => void replan(g.current.epoch, "manual")} className="btn">
          🧠 Replan
        </button>
        <button disabled={!ready} onClick={toggleRecord} className={`btn ${recording ? "btn-hot" : ""}`}>
          {recording ? "■ Stop & save video" : "● Record"}
        </button>
        <span className="ml-auto text-xs text-zinc-500">
          {ticks} player decisions · WASD/←→ to drive yourself while agents are paused
        </span>
      </div>
      {error && <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
    </div>
  );
}
