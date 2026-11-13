import type { Level } from "./level";

// Hand-written starter levels. The designer agent produces more at runtime
// (app/api/design/route.ts). Lesson from the first runs: objects that exist
// only in the prompt must be BIG and visually loud (or be in the image),
// otherwise LingBot doesn't render them.

const JETSKI_VIEW =
  "Third-person chase view from behind and above a rider on a white jet ski on turquoise tropical water. The jet ski is the player.";
const JETSKI_MOVING =
  "The jet ski races forward across the water, spraying white wake behind it, the camera chasing close behind at a fixed distance.";
const JETSKI_STILL =
  "The jet ski idles, bobbing gently on small waves, the camera holding steady behind the rider.";

export const BUILTIN_LEVELS: Level[] = [
  {
    id: "ring-run",
    title: "Ring Run",
    brief: "Slalom the jet ski through a line of giant glowing rings floating on the bay.",
    goal: "Drive through 5 glowing rings",
    image: "/levels/ring-run.jpg", // generated from case2_1012.jpg with imagePrompt
    imagePrompt:
      "Add a slalom course of five huge glowing neon-orange rings standing upright on the water ahead of the jet ski, each ring as tall as a house, spaced far apart and zig-zagging left and right toward the horizon. Keep the jet ski, rider, camera angle, beach and lighting exactly the same.",
    author: "handmade",
    viewpoint: JETSKI_VIEW,
    prompt: {
      base: "A rider in a red life vest on a white jet ski on bright turquoise tropical water, seen from behind and above in a third-person chase view. A slalom course of huge glowing neon-orange rings, each as tall as a house, stands upright on the water ahead, spaced far apart and zig-zagging left and right toward the horizon. Sandy palm-lined beach on the right, sunny clear sky.",
      moving: JETSKI_MOVING,
      still: JETSKI_STILL,
    },
    targets: [
      { id: "ring", label: "ring", describe: "the nearest huge glowing neon-orange ring standing upright on the water ahead" },
      { id: "jetski", label: "player", describe: "the jet ski and its rider" },
    ],
    plan: {
      start: "find",
      nodes: [
        { id: "find", label: "Find next ring", mode: "search", target: "ring",
          when: "No glowing orange ring is visible ahead of the jet ski.", next: ["approach"] },
        { id: "approach", label: "Line up + approach", mode: "steer", target: "ring",
          when: "A glowing orange ring is visible ahead on the water but is still some distance away.", next: ["through", "find"] },
        { id: "through", label: "Punch through", mode: "act", actions: ["forward"],
          when: "A glowing orange ring is very close and fills much of the frame directly ahead; the jet ski is about to pass through it.", next: ["find"] },
      ],
    },
    rubric: {
      events: [
        { id: "ring_pass", label: "RING", points: 1, repeat: true, cooldownS: 4,
          evidence: { target: "ring", minSize: 0.35 },
          question:
            "Did the jet ski just pass THROUGH a glowing orange ring? In the FIRST image a ring is close ahead of the jet ski; in the LAST image the jet ski is inside the ring or the ring has slipped past/behind it at the frame edges. A ring that is still ahead in both images, or one the jet ski went around, does not count." },
      ],
      winPoints: 5,
      timeLimitS: 150,
    },
  },
  {
    id: "buoy-run",
    title: "Buoy Run",
    brief: "Steer the jet ski to a red buoy, then land on the beach.",
    goal: "Touch the red buoy, then land on the beach",
    image: "/lingbot-cases/case2_1012.jpg",
    author: "handmade",
    viewpoint: JETSKI_VIEW,
    prompt: {
      base: "A rider in a red life vest on a white-and-red jet ski on bright turquoise tropical water, seen from behind and above in a third-person chase view. There is EXACTLY ONE large round red marker buoy floating on the water to the right, and a sandy beach lined with palm trees along the right shore. Sunny day, clear sky, distant green hills.",
      moving: JETSKI_MOVING,
      still: JETSKI_STILL,
    },
    targets: [
      { id: "buoy", label: "red buoy", describe: "the large round red marker buoy floating on the water" },
      { id: "beach", label: "beach", describe: "the sandy beach shoreline with palm trees" },
      { id: "jetski", label: "player", describe: "the jet ski and its rider" },
    ],
    plan: {
      start: "find_buoy",
      nodes: [
        { id: "find_buoy", label: "Find the buoy", mode: "search", target: "buoy",
          when: "No red buoy is visible.", next: ["to_buoy"] },
        { id: "to_buoy", label: "Go to buoy", mode: "steer", target: "buoy",
          when: "A red buoy is visible on the water but not yet right beside the jet ski.", next: ["find_beach"] },
        { id: "find_beach", label: "Find the beach", mode: "search", target: "beach",
          when: "The red buoy is right beside or just behind the jet ski, and the beach is not straight ahead.", next: ["to_beach"] },
        { id: "to_beach", label: "Land on beach", mode: "steer", target: "beach",
          when: "The sandy beach is visible ahead and the buoy is already behind.", next: [] },
      ],
    },
    rubric: {
      events: [
        { id: "buoy", label: "BUOY", points: 1, repeat: false,
          question: "In the LAST image, is a red buoy directly beside the jet ski, within a couple of boat lengths? A buoy far in the distance does not count." },
        { id: "landed", label: "LANDED", points: 1, repeat: false,
          question: "In the LAST image, has the jet ski reached the shoreline, with sand or the water's edge directly in front of or beneath it? Seeing the beach in the distance does not count." },
      ],
      winPoints: 2,
      timeLimitS: 120,
    },
  },
  {
    id: "alley-key-door",
    title: "Key to the Neon Door",
    brief: "Grab the giant glowing key in a rainy alley, then unlock the neon shop door.",
    goal: "Grab the golden key, then open the neon door",
    image: "/levels/alley-key.jpg", // generated from case1_0036.jpg with imagePrompt
    imagePrompt:
      "Add one giant glowing golden key, as long as a baseball bat, floating and slowly spinning above a metal trash can on the left side of the alley, casting warm golden light on the wet cobblestones. Keep the officer, camera angle, alley and lighting exactly the same.",
    author: "handmade",
    viewpoint:
      "Third-person view from behind a SWAT officer walking down a rainy cobblestone alley at night. The officer is the player.",
    prompt: {
      base: "A lone SWAT officer in black tactical gear walking down a narrow rain-soaked cobblestone alley at night, seen from behind in third person. EXACTLY ONE giant glowing golden key, as long as a baseball bat, floats diagonally beside a metal trash can on the left side of the alley, casting warm golden light. On the right side, EXACTLY ONE shop door framed by bright blue neon light. Brick walls, fire escapes, street lamps, heavy rain, reflective wet stones. Cinematic noir.",
      moving: "The officer walks steadily forward, boots splashing through puddles, the camera following close behind him at a fixed distance.",
      still: "The officer stands still in the rain, breathing slowly, the camera holding steady behind him.",
    },
    targets: [
      { id: "key", label: "golden key", describe: "the giant glowing golden key (floating above the trash can, or in the officer's hand)" },
      { id: "door", label: "neon door", describe: "the shop door on the right framed by blue neon light" },
      { id: "officer", label: "player", describe: "the SWAT officer the camera follows" },
    ],
    plan: {
      start: "find_key",
      nodes: [
        { id: "find_key", label: "Find the key", mode: "search", target: "key",
          when: "No glowing golden key is visible and the officer is not holding one.", next: ["to_key"] },
        { id: "to_key", label: "Walk to key", mode: "steer", target: "key",
          when: "The glowing golden key is visible ahead but more than an arm's reach from the officer.", next: ["grab"] },
        { id: "grab", label: "Grab key", mode: "interact", target: "key",
          interaction: {
            label: "grab key",
            event: "The officer reaches up and grabs the giant glowing golden key out of the air, holding it up in his right hand as it glows brightly.",
            after: "The officer now carries the giant glowing golden key in his right hand.",
          },
          when: "The glowing golden key is directly beside the officer, within arm's reach, not yet in his hand.", next: ["find_door"] },
        { id: "find_door", label: "Find the door", mode: "search", target: "door",
          when: "The officer holds the golden key and the blue neon door is not visible.", next: ["to_door"] },
        { id: "to_door", label: "Walk to door", mode: "steer", target: "door",
          when: "The officer holds the golden key and the blue neon door is visible but not yet within reach.", next: ["open"] },
        { id: "open", label: "Unlock door", mode: "interact", target: "door",
          interaction: {
            label: "unlock",
            event: "The officer turns to the blue neon shop door, pushes the glowing golden key into the lock and swings the door wide open; warm golden light floods out into the rainy alley.",
            after: "The blue neon shop door stands wide open with warm golden light spilling onto the wet stones.",
          },
          when: "The closed blue neon door is directly beside the officer, within reach, and he holds the golden key.", next: [] },
      ],
    },
    rubric: {
      events: [
        { id: "key_held", label: "KEY", points: 1, repeat: false,
          question: "In the LAST image, is the officer visibly holding a large glowing golden key in his hand? A key still floating in the air, or an empty hand, does not count." },
        { id: "door_open", label: "DOOR OPEN", points: 2, repeat: false,
          question: "In the LAST image, is a shop door visibly standing OPEN with warm light coming out of the doorway? A closed door or a lit window does not count." },
      ],
      winEvent: "door_open",
      timeLimitS: 150,
    },
  },
];
