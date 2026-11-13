// A Level is the contract between the two agents.
//
// The *designer* (an LLM, or a human editing JSON) writes it: what world
// LingBot World 2 should generate, which objects matter, and an ordered list
// of objectives with purely visual success checks.
//
// The *player* (Jev, via the Decisions API) reads it every tick: it boxes each
// target, judges each check from the live frames, and picks the next control.
//
// LingBot has no game engine underneath — the "world state" is just the
// prompt. So an interaction (pick up the key, open the door) is a prompt
// clause the app weaves in, and whether it "worked" is decided by Jev looking
// at the result. That gap is exactly what this project is probing.

export type Target = {
  /** Stable id, e.g. "key". */
  id: string;
  /** Short label drawn on the bounding box, e.g. "brass key". */
  label: string;
  /** Visual description used for the box + visibility questions. */
  describe: string;
};

export type Interaction = {
  /** Button-style label shown in the HUD, e.g. "pick up". */
  label: string;
  /** Prompt clause sent while the interaction plays out. */
  event: string;
  /** Clause that stays in the prompt afterwards (the new world state). */
  after: string;
};

export type Stage = {
  id: string;
  /** Imperative objective, e.g. "Pick up the brass key". */
  title: string;
  /** Target the player should find/approach for this stage. */
  target: string;
  /** Strict yes/no visual question: the stage is complete. */
  done: string;
  /**
   * Optional interaction. When present the player may choose `interact`, and
   * the app only honours it when `ready` is judged true.
   */
  interaction?: Interaction;
  /** Strict yes/no visual question: the interaction can be performed now. */
  ready?: string;
};

export type Level = {
  id: string;
  title: string;
  /** One-line pitch shown in the HUD. */
  brief: string;
  /** Starting image: a public path or a data: URL. */
  image: string;
  /** Who/what the player controls and from what viewpoint (for Jev). */
  viewpoint: string;
  prompt: {
    /** World identity: subject, environment, objects, style. */
    base: string;
    /** Appended while a movement/turn control is held. */
    moving: string;
    /** Appended while idle. */
    still: string;
  };
  targets: Target[];
  stages: Stage[];
  /** Who wrote it — "handmade" or the designer model id. */
  author?: string;
};

export const ACTIONS = {
  forward: "Hold W: move forward toward the current target along open, traversable ground.",
  back: "Hold S: move backward to recover from an obstacle or overshoot.",
  strafe_left: "Hold A: sidestep left to line up with the target or go around an obstacle.",
  strafe_right: "Hold D: sidestep right to line up with the target or go around an obstacle.",
  turn_left: "Hold the left arrow: turn left to find the target or center it in view.",
  turn_right: "Hold the right arrow: turn right to find the target or center it in view.",
  interact: "Perform the current stage's interaction. Only when its target is clearly within reach right now.",
  wait: "Release all controls and observe again (the view is unclear or settling).",
} as const;

export type Action = keyof typeof ACTIONS;

export type Box = { top: number; bottom: number; left: number; right: number };

/** Clamp a level coming from an LLM or localStorage into something safe. */
export function validateLevel(raw: unknown): Level {
  const l = raw as Level;
  const str = (v: unknown, max = 1200) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
  if (!l || typeof l !== "object") throw new Error("Level is not an object");
  const title = str(l.title, 80);
  const base = str(l.prompt?.base, 2000);
  if (!title || !base) throw new Error("Level needs a title and prompt.base");
  const targets = (Array.isArray(l.targets) ? l.targets : [])
    .slice(0, 4)
    .map((t) => ({
      id: str(t?.id, 40) ?? "",
      label: str(t?.label, 40) ?? "",
      describe: str(t?.describe, 400) ?? "",
    }))
    .filter((t) => t.id && t.label && t.describe);
  const ids = new Set(targets.map((t) => t.id));
  const stages = (Array.isArray(l.stages) ? l.stages : [])
    .slice(0, 4)
    .map((s, i) => {
      const interaction =
        s?.interaction && str(s.interaction.event) && str(s.interaction.after)
          ? {
              label: str(s.interaction.label, 30) ?? "interact",
              event: str(s.interaction.event)!,
              after: str(s.interaction.after)!,
            }
          : undefined;
      return {
        id: str(s?.id, 40) ?? `stage_${i + 1}`,
        title: str(s?.title, 80) ?? `Stage ${i + 1}`,
        target: str(s?.target, 40) ?? "",
        done: str(s?.done, 600) ?? "",
        interaction,
        ready: interaction ? (str(s?.ready, 600) ?? undefined) : undefined,
      };
    })
    .filter((s) => ids.has(s.target) && s.done && (!s.interaction || s.ready));
  if (!targets.length || !stages.length)
    throw new Error("Level needs at least one target and one valid stage");
  return {
    id: str(l.id, 60) ?? `level_${Date.now()}`,
    title,
    brief: str(l.brief, 200) ?? "",
    image: typeof l.image === "string" ? l.image : "",
    viewpoint: str(l.viewpoint, 400) ?? "Third-person view of the player character.",
    prompt: {
      base,
      moving: str(l.prompt?.moving, 800) ?? "",
      still: str(l.prompt?.still, 800) ?? "",
    },
    targets,
    stages,
    author: str(l.author, 60) ?? undefined,
  };
}

/**
 * The prompt LingBot sees. `afters` are the persisted outcomes of completed
 * interactions; `event` is an interaction currently playing out.
 */
export function composePrompt(
  level: Level,
  moving: boolean,
  afters: string[],
  event?: string,
): string {
  return [
    level.prompt.base,
    ...afters,
    event ?? (moving ? level.prompt.moving : level.prompt.still),
  ]
    .filter(Boolean)
    .join(" ");
}
