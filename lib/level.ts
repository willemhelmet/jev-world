// A Level is the contract between four agents:
//
//   Designer  writes it: the world (image + prompt), the goal, a plan graph,
//             and a scoring rubric.
//   Planner   owns the plan graph and rewrites it when the player is stuck.
//   Player    (Jev) recognises which plan state it is in from the live frames
//             and drives: steer toward a target's bounding box, search for it,
//             pick an action, or trigger an interaction.
//   Referee   (a second, independent Jev) sees only frames + the rubric and
//             awards points. It never sees the plan or the player's reasoning.
//
// LingBot World 2 has no game engine underneath — objects exist because the
// image and prompt say so, and an interaction is a prompt clause. Whether
// anything actually happened is decided by the referee looking at frames.

export const ACTIONS = {
  forward: "Hold W: move forward along open, traversable space.",
  back: "Hold S: move backward to recover from an obstacle or overshoot.",
  strafe_left: "Hold A: sidestep left.",
  strafe_right: "Hold D: sidestep right.",
  turn_left: "Hold the left arrow: turn left.",
  turn_right: "Hold the right arrow: turn right.",
  wait: "Release all controls and observe.",
} as const;
export type Action = keyof typeof ACTIONS;
export const ACTION_IDS = Object.keys(ACTIONS) as Action[];

export type Box = { top: number; bottom: number; left: number; right: number };

export type Target = {
  id: string;
  /** Short label drawn on the bounding box. Use "player" for the controlled character/vehicle. */
  label: string;
  /** Visual description used for the box + visibility questions. */
  describe: string;
};

export type Interaction = {
  label: string;
  /** Prompt clause played for a few seconds while it happens. */
  event: string;
  /** Prompt clause kept afterwards: the new world state. */
  after: string;
};

export type NodeMode =
  | "search" //   turn to find `target`
  | "steer" //    drive toward `target`, steering by its bounding box
  | "act" //      let Jev pick from `actions`
  | "interact"; // trigger `interaction` (on arrival at this state)

export type PlanNode = {
  id: string;
  /** 2-4 words, shown in the graph. */
  label: string;
  /** What the LAST frame looks like when the player is in this state. */
  when: string;
  mode: NodeMode;
  target?: string;
  actions?: Action[];
  interaction?: Interaction;
  /** Ids of states that can follow this one. */
  next: string[];
};

export type Plan = { start: string; nodes: PlanNode[] };

export type ScoreEvent = {
  id: string;
  /** Toast text, e.g. "RING". */
  label: string;
  /** Yes/no question comparing the FIRST frame (~1s earlier) with the LAST frame. */
  question: string;
  points: number;
  /** Can it score again (rings), or only once (door opened)? */
  repeat: boolean;
  /** Minimum seconds between repeats. */
  cooldownS?: number;
  /**
   * Evidence gate: only award the point if, within the last ~2.5s, the
   * player's own bounding box showed `target` this big (box height as a
   * fraction of the frame) and roughly centred — i.e. it was really being
   * approached. Guards against the world drifting and a far-away object
   * simply vanishing between the referee's two frames.
   */
  evidence?: { target: string; minSize: number };
};

export type Rubric = {
  events: ScoreEvent[];
  /** Level complete at this many points … */
  winPoints?: number;
  /** … or when this event fires. */
  winEvent?: string;
  timeLimitS?: number;
};

export type Level = {
  id: string;
  title: string;
  /** One-line pitch for the level list. */
  brief: string;
  /** The call to action everyone sees, e.g. "Drive through all 5 rings". */
  goal: string;
  /** Starting image: public path, /api/generated/… path, or data: URL. */
  image: string;
  /** How the designer asked for the image (when generated). */
  imagePrompt?: string;
  /** Who/what the player controls and from what viewpoint. */
  viewpoint: string;
  prompt: { base: string; moving: string; still: string };
  targets: Target[];
  plan: Plan;
  rubric: Rubric;
  author?: string;
};

// ---- validation ------------------------------------------------------------

const str = (v: unknown, max = 1200) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const slug = (v: unknown, fallback: string) =>
  (str(v, 40) ?? fallback).replace(/[^\w-]/g, "_");

export function validatePlan(raw: unknown, targetIds: Set<string>): Plan {
  const p = raw as Plan;
  const nodes = (Array.isArray(p?.nodes) ? p.nodes : []).slice(0, 10).map((n, i) => {
    const mode: NodeMode = ["search", "steer", "act", "interact"].includes(n?.mode) ? n.mode : "act";
    const interaction =
      n?.interaction && str(n.interaction.event) && str(n.interaction.after)
        ? {
            label: str(n.interaction.label, 30) ?? "interact",
            event: str(n.interaction.event)!,
            after: str(n.interaction.after)!,
          }
        : undefined;
    return {
      id: slug(n?.id, `s${i + 1}`),
      label: str(n?.label, 40) ?? `state ${i + 1}`,
      when: str(n?.when, 500) ?? "",
      mode: mode === "interact" && !interaction ? "act" : mode,
      target: str(n?.target, 40) ?? undefined,
      actions: (Array.isArray(n?.actions) ? n.actions : []).filter((a): a is Action =>
        (ACTION_IDS as string[]).includes(a),
      ),
      interaction,
      next: (Array.isArray(n?.next) ? n.next : []).map((x) => slug(x, "")),
    } satisfies PlanNode;
  });
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    n.next = n.next.filter((x) => ids.has(x) && x !== n.id);
    if (n.target && !targetIds.has(n.target)) n.target = undefined;
    if ((n.mode === "steer" || n.mode === "search" || n.mode === "interact") && !n.target)
      n.mode = "act";
    if (n.mode === "act" && !n.actions?.length) n.actions = ["forward", "turn_left", "turn_right", "wait"];
  }
  const good = nodes.filter((n) => n.when);
  if (!good.length) throw new Error("Plan needs at least one state with a `when` description");
  const start = ids.has(str(p?.start, 40) ?? "") ? p.start : good[0].id;
  return { start, nodes: good };
}

export function validateLevel(raw: unknown): Level {
  const l = raw as Level;
  if (!l || typeof l !== "object") throw new Error("Level is not an object");
  const title = str(l.title, 80);
  const base = str(l.prompt?.base, 2000);
  if (!title || !base) throw new Error("Level needs a title and prompt.base");
  const targets = (Array.isArray(l.targets) ? l.targets : [])
    .slice(0, 5)
    .map((t, i) => ({
      id: slug(t?.id, `t${i}`),
      label: str(t?.label, 40) ?? "",
      describe: str(t?.describe, 400) ?? "",
    }))
    .filter((t) => t.label && t.describe);
  if (!targets.length) throw new Error("Level needs at least one target");
  const targetIds = new Set(targets.map((t) => t.id));
  const plan = validatePlan(l.plan, targetIds);
  const events = (Array.isArray(l.rubric?.events) ? l.rubric.events : [])
    .slice(0, 6)
    .map((e, i) => ({
      id: slug(e?.id, `e${i}`),
      label: str(e?.label, 24) ?? "POINT",
      question: str(e?.question, 600) ?? "",
      points: Number.isFinite(e?.points) ? Math.max(0, Math.min(100, Number(e.points))) : 1,
      repeat: !!e?.repeat,
      cooldownS: Number.isFinite(e?.cooldownS) ? Math.max(1, Math.min(30, Number(e.cooldownS))) : 4,
      evidence:
        e?.evidence && targetIds.has(String(e.evidence.target)) && Number.isFinite(e.evidence.minSize)
          ? { target: String(e.evidence.target), minSize: Math.max(0.05, Math.min(0.95, Number(e.evidence.minSize))) }
          : undefined,
    }))
    .filter((e) => e.question);
  if (!events.length) throw new Error("Rubric needs at least one scoring event");
  const eventIds = new Set(events.map((e) => e.id));
  const winEvent = eventIds.has(str(l.rubric?.winEvent, 40) ?? "") ? l.rubric.winEvent : undefined;
  const winPoints = Number.isFinite(l.rubric?.winPoints) ? Number(l.rubric.winPoints) : undefined;
  return {
    id: slug(l.id, `level_${Date.now()}`),
    title,
    brief: str(l.brief, 200) ?? "",
    goal: str(l.goal, 120) ?? title,
    image: typeof l.image === "string" ? l.image : "",
    imagePrompt: str(l.imagePrompt, 1500) ?? undefined,
    viewpoint: str(l.viewpoint, 400) ?? "Third-person view of the player character.",
    prompt: { base, moving: str(l.prompt?.moving, 800) ?? "", still: str(l.prompt?.still, 800) ?? "" },
    targets,
    plan,
    rubric: {
      events,
      winEvent,
      winPoints: winPoints ?? (winEvent ? undefined : events.reduce((a, e) => a + e.points, 0)),
      timeLimitS: Number.isFinite(l.rubric?.timeLimitS) ? Math.max(15, Math.min(600, Number(l.rubric.timeLimitS))) : 120,
    },
    author: str(l.author, 60) ?? undefined,
  };
}

/** The prompt LingBot sees. */
export function composePrompt(level: Level, moving: boolean, afters: string[], event?: string): string {
  return [level.prompt.base, ...afters, event ?? (moving ? level.prompt.moving : level.prompt.still)]
    .filter(Boolean)
    .join(" ");
}

/** Mermaid source for the plan, with the current state highlighted. */
export function planToMermaid(plan: Plan, current?: string): string {
  const esc = (s: string) => s.replace(/["[\]{}()<>]/g, " ");
  const shape = (n: PlanNode) => {
    const text = `${esc(n.label)}<br/><small>${n.mode}${n.target ? " " + esc(n.target) : ""}</small>`;
    return n.mode === "interact" ? `${n.id}{{"${text}"}}` : `${n.id}["${text}"]`;
  };
  const lines = ["flowchart TD", ...plan.nodes.map((n) => `  ${shape(n)}`)];
  for (const n of plan.nodes) for (const x of n.next) lines.push(`  ${n.id} --> ${x}`);
  lines.push("  classDef cur fill:#0f3d2e,stroke:#38f8b0,stroke-width:3px,color:#fff");
  lines.push("  classDef start stroke-dasharray:4 3");
  lines.push(`  class ${plan.start} start`);
  if (current && plan.nodes.some((n) => n.id === current)) lines.push(`  class ${current} cur`);
  return lines.join("\n");
}
