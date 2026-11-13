import type { Action, Box, Level, Plan } from "./level";

// Everything in the demo is drawn onto ONE canvas: the live LingBot frame plus
// the agents' view of it. Recording that canvas = the demo video.

export type PlayerDecision = {
  state: { choice: string; probabilities: Record<string, number> } | null;
  action: { choice: string; probabilities: Record<string, number> } | null;
  boxes: Record<string, { box: Box; seen: number | null; confidence?: number | null }>;
  latencyMs: number;
};

export type HudState = {
  level: Level;
  plan: Plan;
  current: string;
  control: string; // human-readable control currently held
  decision: PlayerDecision | null;
  referee: Record<string, number>; // latest event probabilities
  refereeMs: number;
  score: number;
  startedAt: number | null;
  endedAt: number | null;
  outcome: "won" | "time" | null;
  replanning: boolean;
  banner: { text: string; until: number; color?: string } | null;
  toasts: { text: string; at: number }[];
  log: string[];
  ticks: number;
  recording: boolean;
};

const MINT = "#38f8b0";
const AMBER = "#ffcc33";
const COLORS = [MINT, AMBER, "#ff5fa2", "#5ab8ff", "#c38bff"];
const MODE_ICON: Record<string, string> = { search: "⟲", steer: "➤", act: "◆", interact: "⚡" };

// Boxes jump between ticks; ease toward the newest one every frame.
const smoothed = new Map<string, Box & { alpha: number }>();
export function resetOverlay() {
  smoothed.clear();
}
function ease(id: string, target: Box | null, visible: boolean) {
  const cur = smoothed.get(id);
  if (!target) {
    if (cur) cur.alpha *= 0.9;
    return cur;
  }
  if (!cur) {
    const fresh = { ...target, alpha: 0 };
    smoothed.set(id, fresh);
    return fresh;
  }
  const k = 0.2;
  cur.top += (target.top - cur.top) * k;
  cur.bottom += (target.bottom - cur.bottom) * k;
  cur.left += (target.left - cur.left) * k;
  cur.right += (target.right - cur.right) * k;
  cur.alpha += ((visible ? 1 : 0) - cur.alpha) * 0.15;
  return cur;
}

export function elapsedS(h: HudState, now: number) {
  if (!h.startedAt) return 0;
  return ((h.endedAt ?? now) - h.startedAt) / 1000;
}

export function drawFrame(ctx: CanvasRenderingContext2D, video: HTMLVideoElement | null, h: HudState, now: number) {
  const { width: W, height: H } = ctx.canvas;
  const s = W / 1248;
  ctx.clearRect(0, 0, W, H);
  if (video && video.readyState >= 2) ctx.drawImage(video, 0, 0, W, H);
  else {
    ctx.fillStyle = "#07080b";
    ctx.fillRect(0, 0, W, H);
  }
  const sans = (px: number, wt = 600) => `${wt} ${Math.round(px * s)}px ui-sans-serif, system-ui, sans-serif`;
  const mono = (px: number) => `${Math.round(px * s)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const panel = (x: number, y: number, w: number, hh: number) => {
    ctx.fillStyle = "rgba(8,10,14,0.64)";
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = s;
    ctx.beginPath();
    ctx.roundRect(x, y, w, hh, 10 * s);
    ctx.fill();
    ctx.stroke();
  };
  const node = h.plan.nodes.find((n) => n.id === h.current);
  const activeTarget = h.outcome ? undefined : node?.target;

  // ---- bounding boxes -------------------------------------------------------
  h.level.targets.forEach((t, i) => {
    const d = h.decision?.boxes[t.id];
    const seen = (d?.seen ?? 0) >= 0.5;
    const b = ease(t.id, d?.box ?? null, seen);
    if (!b || b.alpha < 0.03) return;
    const isPlayer = t.label === "player";
    const active = t.id === activeTarget;
    const color = isPlayer ? "#9aa4b2" : COLORS[i % COLORS.length];
    const x = b.left * W, y = b.top * H, w = (b.right - b.left) * W, hh = (b.bottom - b.top) * H;
    ctx.save();
    ctx.globalAlpha = b.alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = (active ? 3 : 1.6) * s;
    if (active) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 14 * s;
    }
    if (isPlayer) ctx.setLineDash([6 * s, 5 * s]);
    const c = Math.min(w, hh) * 0.22;
    ctx.beginPath();
    for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + hh, 1, -1], [x + w, y + hh, -1, -1]] as const) {
      ctx.moveTo(cx + dx * c, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * c);
    }
    ctx.stroke();
    if (active) {
      // steering line from screen center-bottom to the target
      ctx.setLineDash([4 * s, 6 * s]);
      ctx.lineWidth = 1.5 * s;
      ctx.globalAlpha = b.alpha * 0.7;
      ctx.beginPath();
      ctx.moveTo(W / 2, H * 0.92);
      ctx.lineTo(x + w / 2, y + hh / 2);
      ctx.stroke();
    }
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = b.alpha;
    ctx.font = sans(12);
    const label = `${t.label}  ${Math.round((d?.seen ?? 0) * 100)}%`;
    const tw = ctx.measureText(label).width + 12 * s;
    const ly = y > 24 * s ? y - 22 * s : y + 4 * s;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, ly, tw, 18 * s, 4 * s);
    ctx.fill();
    ctx.fillStyle = "#07080b";
    ctx.fillText(label, x + 6 * s, ly + 13 * s);
    ctx.restore();
  });

  // ---- goal + score + plan (top-left) -------------------------------------
  const px = 16 * s, py = 16 * s, pw = 330 * s;
  const ph = (112 + h.plan.nodes.length * 22) * s;
  panel(px, py, pw, ph);
  ctx.fillStyle = MINT;
  ctx.font = sans(10, 700);
  ctx.fillText("JEV × LINGBOT WORLD 2", px + 14 * s, py + 20 * s);
  ctx.fillStyle = "#f4f6f8";
  ctx.font = sans(16, 650);
  ctx.fillText(h.level.goal.slice(0, 34), px + 14 * s, py + 42 * s);
  // score + timer
  const target = h.level.rubric.winPoints;
  ctx.font = sans(26, 800);
  ctx.fillStyle = AMBER;
  ctx.fillText(`★ ${h.score}${target ? ` / ${target}` : ""}`, px + 14 * s, py + 76 * s);
  const limit = h.level.rubric.timeLimitS ?? 0;
  const left = Math.max(0, limit - elapsedS(h, now));
  ctx.font = mono(15);
  ctx.textAlign = "right";
  ctx.fillStyle = left < 15 && h.startedAt && !h.outcome ? "#ff6b6b" : "#c9ced6";
  ctx.fillText(
    h.startedAt ? `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}` : "--:--",
    px + pw - 14 * s,
    py + 74 * s,
  );
  ctx.textAlign = "left";
  ctx.fillStyle = "#7b8492";
  ctx.font = sans(10, 700);
  ctx.fillText(h.replanning ? "PLAN · REPLANNING…" : "PLAN", px + 14 * s, py + 98 * s);
  h.plan.nodes.forEach((n, i) => {
    const y = py + (118 + i * 22) * s;
    const cur = n.id === h.current && !h.outcome;
    if (cur) {
      ctx.fillStyle = "rgba(56,248,176,0.14)";
      ctx.beginPath();
      ctx.roundRect(px + 8 * s, y - 15 * s, pw - 16 * s, 20 * s, 5 * s);
      ctx.fill();
    }
    ctx.font = sans(13, cur ? 650 : 450);
    ctx.fillStyle = cur ? "#f4f6f8" : "#7b8492";
    const nexts = n.next.length ? `  → ${n.next.map((x) => h.plan.nodes.find((m) => m.id === x)?.label ?? x).join(" / ")}` : "";
    ctx.fillText(`${MODE_ICON[n.mode] ?? "·"}  ${n.label}`, px + 14 * s, y);
    ctx.font = sans(10, 450);
    ctx.fillStyle = "#59616e";
    const lw = ctx.measureText(nexts).width;
    if (lw < pw * 0.5) {
      ctx.textAlign = "right";
      ctx.fillText(nexts, px + pw - 14 * s, y);
      ctx.textAlign = "left";
    }
  });

  // ---- player + referee (top-right) ----------------------------------------
  const d = h.decision;
  const rw = 262 * s, rx = W - rw - 16 * s, ry = 16 * s;
  const events = h.level.rubric.events;
  const acts: Action[] = ["forward", "back", "strafe_left", "strafe_right", "turn_left", "turn_right", "wait"];
  const rh = (78 + acts.length * 17 + 30 + events.length * 20) * s;
  panel(rx, ry, rw, rh);
  ctx.fillStyle = "#7b8492";
  ctx.font = sans(10, 700);
  ctx.fillText("PLAYER · JEV", rx + 14 * s, ry + 20 * s);
  ctx.textAlign = "right";
  ctx.font = mono(10);
  ctx.fillText(d ? `${d.latencyMs}ms` : "", rx + rw - 14 * s, ry + 20 * s);
  ctx.textAlign = "left";
  ctx.fillStyle = "#f4f6f8";
  ctx.font = sans(17, 700);
  ctx.fillText(h.control || "—", rx + 14 * s, ry + 44 * s);
  ctx.fillStyle = "#9aa4b2";
  ctx.font = sans(11, 500);
  const sp = d?.state?.probabilities[h.current];
  ctx.fillText(`state: ${node?.label ?? h.current}${sp != null ? `  (${Math.round(sp * 100)}%)` : ""}`, rx + 14 * s, ry + 62 * s);
  acts.forEach((a, i) => {
    const y = ry + (74 + i * 17) * s;
    const p = d?.action?.probabilities[a] ?? 0;
    const chosen = d?.action?.choice === a;
    ctx.font = mono(10.5);
    ctx.fillStyle = chosen ? "#f4f6f8" : "#7b8492";
    ctx.fillText(a.replace("_", " "), rx + 14 * s, y + 9 * s);
    const bx = rx + 104 * s, bw = 112 * s;
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.fillRect(bx, y + 1 * s, bw, 8 * s);
    ctx.fillStyle = chosen ? MINT : "rgba(56,248,176,0.45)";
    ctx.fillRect(bx, y + 1 * s, bw * p, 8 * s);
    ctx.fillStyle = "#7b8492";
    ctx.fillText(`${Math.round(p * 100)}`.padStart(3), bx + bw + 6 * s, y + 9 * s);
  });
  let y2 = ry + (74 + acts.length * 17 + 18) * s;
  ctx.fillStyle = "#7b8492";
  ctx.font = sans(10, 700);
  ctx.fillText("REFEREE · JEV", rx + 14 * s, y2);
  ctx.textAlign = "right";
  ctx.font = mono(10);
  ctx.fillText(h.refereeMs ? `${h.refereeMs}ms` : "", rx + rw - 14 * s, y2);
  ctx.textAlign = "left";
  events.forEach((e, i) => {
    const y = y2 + (8 + i * 20) * s;
    const p = h.referee[e.id] ?? 0;
    ctx.font = mono(10.5);
    ctx.fillStyle = p >= 0.7 ? AMBER : "#9aa4b2";
    ctx.fillText(e.label.slice(0, 12), rx + 14 * s, y + 10 * s);
    const bx = rx + 104 * s, bw = 112 * s;
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.fillRect(bx, y + 2 * s, bw, 8 * s);
    ctx.fillStyle = p >= 0.7 ? AMBER : "rgba(255,204,51,0.45)";
    ctx.fillRect(bx, y + 2 * s, bw * p, 8 * s);
    // threshold tick
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillRect(bx + bw * 0.7, y, 1 * s, 12 * s);
  });

  // ---- log (bottom-left) ---------------------------------------------------
  const lines = h.log.slice(-4);
  if (lines.length) {
    const lh = (16 + lines.length * 17) * s;
    panel(16 * s, H - lh - 16 * s, 470 * s, lh);
    ctx.font = mono(12.5);
    lines.forEach((l, i) => {
      ctx.fillStyle = i === lines.length - 1 ? "#dfe3e8" : "#7b8492";
      ctx.fillText(l.slice(0, 62), 28 * s, H - lh - 16 * s + (20 + i * 17) * s);
    });
  }
  ctx.font = mono(11);
  ctx.fillStyle = "rgba(223,227,232,0.75)";
  ctx.textAlign = "right";
  ctx.fillText(`${h.recording ? "● REC   " : ""}tick ${h.ticks}   ${h.level.author ?? ""}`, W - 18 * s, H - 18 * s);
  ctx.textAlign = "left";

  // ---- +1 toasts -------------------------------------------------------------
  for (const t of h.toasts) {
    const age = (now - t.at) / 1400;
    if (age > 1) continue;
    ctx.save();
    ctx.globalAlpha = 1 - age * age;
    ctx.font = sans(46, 900);
    ctx.textAlign = "center";
    ctx.fillStyle = AMBER;
    ctx.shadowColor = AMBER;
    ctx.shadowBlur = 24 * s;
    ctx.fillText(t.text, W / 2, H * 0.5 - age * 90 * s);
    ctx.restore();
  }

  // ---- banners ---------------------------------------------------------------
  const banner = h.outcome
    ? { text: h.outcome === "won" ? `LEVEL COMPLETE · ${elapsedS(h, now).toFixed(1)}s` : `TIME UP · ★ ${h.score}`, color: h.outcome === "won" ? MINT : "#ff6b6b", until: Infinity }
    : h.banner;
  if (banner && now < banner.until) {
    ctx.save();
    ctx.font = sans(34, 800);
    ctx.textAlign = "center";
    const tw = ctx.measureText(banner.text).width;
    panel(W / 2 - tw / 2 - 26 * s, H * 0.3 - 40 * s, tw + 52 * s, 58 * s);
    ctx.fillStyle = banner.color ?? AMBER;
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 16 * s;
    ctx.fillText(banner.text, W / 2, H * 0.3);
    ctx.restore();
  }
}
