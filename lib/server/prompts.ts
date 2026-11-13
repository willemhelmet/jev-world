import "server-only";
import { BUILTIN_LEVELS } from "@/lib/levels";

// Shared knowledge for the LLM agents (designer + planner).

export const WORLD_RULES = `How the world works:
- LingBot World 2 streams video from ONE starting image plus a text prompt. The player can hold forward/back, strafe left/right, and turn left/right (turning while moving forward steers). There is NO game engine: objects exist only because the image/prompt show them.
- Objects that exist only in the prompt render unreliably unless they are BIG, bright and distinctive. Small props (a key on a table) often never appear. Prefer putting key objects in the starting image.
- Interactions (grab, open, ignite…) are implemented by briefly adding an "event" clause to the prompt and then keeping an "after" clause as the new world state.
- The PLAYER is Jev, a decision model. Each tick it classifies which plan state the current frame is in (from each state's "when" description), boxes the targets, and acts according to the state's mode:
    search   turn to find the state's target
    steer    drive toward the target, steering by its bounding box (most reliable way to approach things)
    act      pick one of the state's allowed actions (forward, back, strafe_left, strafe_right, turn_left, turn_right, wait)
    interact fire the state's interaction once the player is in this state ("when" must mean: target within reach)
- The REFEREE is a separate Jev that sees two frames ~1s apart plus the rubric questions. It never sees the plan.`;

export const PLAN_RULES = `Plan rules:
- 2-7 states. Each state's "when" is a concrete visual description of the LAST frame that distinguishes it from the other states (mutually exclusive). Mention what is and is not visible, and how close.
- Every target used by a state must exist in targets. Use search → steer → (act or interact) chains, and loop back for repeated objectives (e.g. next ring).
- ids are short snake_case. labels are 2-4 words.`;

export const RUBRIC_RULES = `Rubric rules:
- Events are strict yes/no questions for the referee. Repeating objectives (rings, coins) compare the FIRST and LAST image ("in the FIRST image X was close ahead; in the LAST image the player has passed through it"). One-off outcomes ask about the LAST image ("In the LAST image, is the door visibly open…"). Always say what does NOT count.
- For events about reaching/passing a target, add "evidence": {"target": "<target id>", "minSize": 0.3-0.4}. The point then only counts if the player's bounding box showed that target big and centred just before (the world drifts, and distant objects can vanish between frames).
- Set winPoints (e.g. 5 rings) or winEvent (the final outcome), and timeLimitS (60-180).`;

export const EXAMPLE_LEVEL = JSON.stringify({
  ...BUILTIN_LEVELS[0],
  image: undefined,
  author: undefined,
});
