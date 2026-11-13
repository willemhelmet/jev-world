import type { Action, Box, Level } from "./level";

// Everything visible in the demo is drawn onto ONE canvas: the live LingBot
// frame plus Jev's boxes and HUD. Recording that canvas = the demo video.

export type Decision = {
  action: Action;
  probabilities: Partial<Record<Action, number>>;
  done: number | null;
  ready: number | null;
  blocked: number | null;
  boxes: Record<string, { box: Box; seen: number | null; confidence?: number }>;
  latencyMs: number;
  cost?: number;
};

export type HudState = {
  level: Level;
  stage: number;
  completed: number; // stages completed
  decision: Decision | null;
  thinking: boolean;
  running: boolean;
  won: boolean;
  banner: { text: string; until: number } | null;
  log: string[];
  ticks: number;
  recording: boolean;
};

const COLORS = ["#38f8b0", "#ffcc33", "#ff5fa2", "#5ab8ff"];
const ACTION_LABEL: Record<Action, string> = {
  forward: "W  forward",
  back: "S  back",
  strafe_left: "A  strafe ←",
  strafe_right: "D  strafe →",
  turn_left: "←  turn",
  turn_right: "→  turn",
  interact: "E  interact",
  wait: "·  wait",
};

// Boxes from successive ticks jump; ease toward the newest one per frame.
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
    const fresh = { ...target, alpha: visible ? 0.01 : 0 };
    smoothed.set(id, fresh);
    return fresh;
  }
  const k = 0.18;
  cur.top += (target.top - cur.top) * k;
  cur.bottom += (target.bottom - cur.bottom) * k;
  cur.left += (target.left - cur.left) * k;
  cur.right += (target.right - cur.right) * k;
  cur.alpha += ((visible ? 1 : 0) - cur.alpha) * 0.15;
  return cur;
}

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: number) {
  ctx.fillStyle = "rgba(8,10,14,0.62)";
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1 * s;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 10 * s);
  ctx.fill();
  ctx.stroke();
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement | null,
  hud: HudState,
  now: number,
) {
  const { width: W, height: H } = ctx.canvas;
  const s = W / 1248;
  ctx.clearRect(0, 0, W, H);
  if (video && video.readyState >= 2) ctx.drawImage(video, 0, 0, W, H);
  else {
    ctx.fillStyle = "#07080b";
    ctx.fillRect(0, 0, W, H);
  }

  const mono = `${Math.round(13 * s)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const monoSm = `${Math.round(11 * s)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const sans = (px: number, wt = 600) => `${wt} ${Math.round(px * s)}px ui-sans-serif, system-ui, sans-serif`;
  const stage = hud.level.stages[Math.min(hud.stage, hud.level.stages.length - 1)];

  // --- bounding boxes ----------------------------------------------------
  hud.level.targets.forEach((t, i) => {
    const d = hud.decision?.boxes[t.id];
    const seen = (d?.seen ?? 0) >= 0.5;
    const b = ease(t.id, d?.box ?? null, seen);
    if (!b || b.alpha < 0.03) return;
    const active = !hud.won && t.id === stage.target;
    const color = t.label === "player" ? "#9aa4b2" : COLORS[i % COLORS.length];
    const x = b.left * W, y = b.top * H, w = (b.right - b.left) * W, h = (b.bottom - b.top) * H;
    ctx.save();
    ctx.globalAlpha = b.alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = (active ? 3 : 1.6) * s;
    if (active) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 14 * s;
    }
    if (t.label === "player") ctx.setLineDash([6 * s, 5 * s]);
    // corner brackets read better than full rectangles over video
    const c = Math.min(w, h) * 0.22;
    ctx.beginPath();
    for (const [cx, cy, dx, dy] of [
      [x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1],
    ] as const) {
      ctx.moveTo(cx + dx * c, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * c);
    }
    ctx.stroke();
    if (active) {
      ctx.globalAlpha = b.alpha * 0.35;
      ctx.setLineDash([]);
      ctx.lineWidth = 1 * s;
      ctx.strokeRect(x, y, w, h);
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

  // --- objectives (top-left) ---------------------------------------------
  const px = 16 * s, py = 16 * s, pw = 330 * s;
  const ph = (62 + hud.level.stages.length * 24) * s;
  panel(ctx, px, py, pw, ph, s);
  ctx.fillStyle = "#38f8b0";
  ctx.font = sans(10, 700);
  ctx.fillText("JEV × LINGBOT WORLD 2", px + 14 * s, py + 20 * s);
  ctx.fillStyle = "#f4f6f8";
  ctx.font = sans(16, 650);
  ctx.fillText(hud.level.title, px + 14 * s, py + 42 * s);
  hud.level.stages.forEach((st, i) => {
    const y = py + (66 + i * 24) * s;
    const doneSt = i < hud.completed;
    const cur = i === hud.stage && !hud.won;
    ctx.font = sans(13, cur ? 600 : 450);
    ctx.fillStyle = doneSt ? "#38f8b0" : cur ? "#f4f6f8" : "#7b8492";
    ctx.fillText(`${doneSt ? "✓" : cur ? "▸" : "○"}  ${st.title}`, px + 14 * s, y);
  });

  // --- Jev's decision (top-right) ----------------------------------------
  const d = hud.decision;
  const actions = Object.keys(ACTION_LABEL) as Action[];
  const visible = actions.filter((a) => a !== "interact" || stage.interaction);
  const rw = 250 * s, rx = W - rw - 16 * s, ry = 16 * s;
  const rh = (54 + visible.length * 19 + 64) * s;
  panel(ctx, rx, ry, rw, rh, s);
  ctx.fillStyle = "#7b8492";
  ctx.font = sans(10, 700);
  ctx.fillText(hud.thinking ? "JEV · DECIDING…" : "JEV · DECISION", rx + 14 * s, ry + 20 * s);
  ctx.fillStyle = "#f4f6f8";
  ctx.font = sans(18, 700);
  ctx.fillText(d ? ACTION_LABEL[d.action] ?? d.action : "—", rx + 14 * s, ry + 44 * s);
  visible.forEach((a, i) => {
    const y = ry + (60 + i * 19) * s;
    const p = d?.probabilities[a] ?? 0;
    const chosen = d?.action === a;
    ctx.font = monoSm;
    ctx.fillStyle = chosen ? "#f4f6f8" : "#7b8492";
    ctx.fillText(ACTION_LABEL[a], rx + 14 * s, y + 10 * s);
    const bx = rx + 112 * s, bw = 96 * s;
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.fillRect(bx, y + 2 * s, bw, 9 * s);
    ctx.fillStyle = chosen ? "#38f8b0" : "rgba(56,248,176,0.45)";
    ctx.fillRect(bx, y + 2 * s, bw * p, 9 * s);
    ctx.fillStyle = "#7b8492";
    ctx.fillText(`${Math.round(p * 100)}`.padStart(3), bx + bw + 6 * s, y + 10 * s);
  });
  const gy = ry + (66 + visible.length * 19) * s;
  const gauge = (label: string, v: number | null, i: number, warn = false) => {
    const x = rx + 14 * s + i * 76 * s;
    ctx.font = monoSm;
    ctx.fillStyle = "#7b8492";
    ctx.fillText(label, x, gy + 10 * s);
    ctx.font = sans(17, 700);
    const hot = v != null && v >= 0.6;
    ctx.fillStyle = v == null ? "#4b5260" : hot ? (warn ? "#ff6b6b" : "#38f8b0") : "#c9ced6";
    ctx.fillText(v == null ? "—" : v.toFixed(2), x, gy + 32 * s);
  };
  gauge("done", d?.done ?? null, 0);
  gauge("ready", stage.interaction ? (d?.ready ?? null) : null, 1);
  gauge("blocked", d?.blocked ?? null, 2, true);

  // --- log (bottom-left) -------------------------------------------------
  const lines = hud.log.slice(-4);
  if (lines.length) {
    const lh = (16 + lines.length * 17) * s;
    panel(ctx, 16 * s, H - lh - 16 * s, 460 * s, lh, s);
    ctx.font = mono;
    lines.forEach((l, i) => {
      ctx.fillStyle = i === lines.length - 1 ? "#dfe3e8" : "#7b8492";
      ctx.fillText(l.slice(0, 60), 28 * s, H - lh - 16 * s + (20 + i * 17) * s);
    });
  }

  // --- stats (bottom-right) ----------------------------------------------
  ctx.font = monoSm;
  ctx.fillStyle = "rgba(223,227,232,0.75)";
  ctx.textAlign = "right";
  ctx.fillText(
    `${hud.recording ? "● REC   " : ""}tick ${hud.ticks}   ${d ? `${d.latencyMs}ms` : ""}   ${hud.level.author ?? ""}`,
    W - 18 * s,
    H - 18 * s,
  );
  ctx.textAlign = "left";

  // --- banners -----------------------------------------------------------
  const banner = hud.won ? { text: "LEVEL COMPLETE", until: Infinity } : hud.banner;
  if (banner && now < banner.until) {
    ctx.save();
    ctx.font = sans(40, 800);
    ctx.textAlign = "center";
    const tw = ctx.measureText(banner.text).width;
    panel(ctx, W / 2 - tw / 2 - 28 * s, H * 0.42 - 44 * s, tw + 56 * s, 66 * s, s);
    ctx.fillStyle = hud.won ? "#38f8b0" : "#ffcc33";
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 18 * s;
    ctx.fillText(banner.text, W / 2, H * 0.42);
    ctx.restore();
  }
}
