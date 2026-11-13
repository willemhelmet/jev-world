import type { Level } from "./level";

// Hand-written starter levels. The level designer agent produces more of
// these at runtime (see app/api/design/route.ts).

export const BUILTIN_LEVELS: Level[] = [
  {
    id: "alley-key-door",
    title: "Key to the Neon Door",
    brief: "Find the brass key in a rainy alley, pick it up, then unlock the blue neon shop door.",
    image: "/lingbot-cases/case1_0036.jpg",
    author: "handmade",
    viewpoint:
      "Third-person view from behind a SWAT officer walking down a rainy cobblestone alley at night. The officer is the player character.",
    prompt: {
      base: "A lone SWAT officer in black tactical gear walking down a narrow rain-soaked cobblestone alley at night, seen from behind in third person. The alley contains EXACTLY ONE metal trash can on the left side with EXACTLY ONE small glowing golden brass key resting on its lid, and EXACTLY ONE shop door on the right side framed by bright blue neon light. Brick walls, fire escapes, glowing street lamps, heavy rain, reflective wet stones. Cinematic noir.",
      moving:
        "The officer walks steadily forward, boots splashing through puddles, the camera following close behind him at a fixed distance.",
      still:
        "The officer stands still in the rain, breathing slowly, the camera holding steady behind him.",
    },
    targets: [
      { id: "key", label: "brass key", describe: "the small glowing golden brass key (on the trash can lid or in the officer's hand)" },
      { id: "door", label: "neon door", describe: "the shop door on the right side of the alley framed by blue neon light" },
      { id: "officer", label: "player", describe: "the SWAT officer the camera follows" },
    ],
    stages: [
      {
        id: "get_key",
        title: "Pick up the brass key",
        target: "key",
        ready:
          "In the LAST image, is a small golden key clearly visible resting on a trash can lid directly beside the officer, close enough for him to reach without walking? A distant key, or no visible key, does not qualify.",
        interaction: {
          label: "pick up",
          event:
            "The officer stops at the trash can, reaches down with his right gloved hand and picks up the glowing golden brass key, lifting it up in front of him.",
          after: "The officer now holds the glowing golden brass key in his right hand; the trash can lid is empty.",
        },
        done:
          "In the LAST image, is the officer visibly holding a small glowing golden key in his hand? A key still lying on a surface, or an empty hand, does not qualify.",
      },
      {
        id: "open_door",
        title: "Unlock the neon door",
        target: "door",
        ready:
          "In the LAST image, is the blue-neon shop door directly in front of or beside the officer, close enough to touch without walking, and still closed?",
        interaction: {
          label: "unlock",
          event:
            "The officer turns to the blue neon shop door, inserts the golden key into the lock and pushes the door open; warm golden light floods out of the doorway into the rainy alley.",
          after: "The blue neon shop door stands wide open with warm golden light spilling out onto the wet stones.",
        },
        done:
          "In the LAST image, is a shop door visibly standing OPEN with warm light coming out of the doorway? A closed door, or a lit window, does not qualify.",
      },
    ],
  },
  {
    id: "jetski-buoy-beach",
    title: "Buoy Run",
    brief: "Steer the jet ski around a red buoy, then land on the beach.",
    image: "/lingbot-cases/case2_1012.jpg",
    author: "handmade",
    viewpoint:
      "Third-person chase view from behind and above a rider on a white-and-red jet ski on turquoise tropical water. The jet ski is the player.",
    prompt: {
      base: "A rider in a red life vest on a white-and-red jet ski on bright turquoise tropical water, seen from behind and above in a third-person chase view. There is EXACTLY ONE large round red marker buoy floating on the water to the right, and a sandy beach lined with palm trees along the right shore. Sunny day, clear sky, distant green hills.",
      moving:
        "The jet ski accelerates across the water, spraying white wake behind it, the camera chasing at a fixed distance.",
      still:
        "The jet ski idles, bobbing gently on small waves, the camera holding steady behind the rider.",
    },
    targets: [
      { id: "buoy", label: "red buoy", describe: "the large round red marker buoy floating on the water" },
      { id: "beach", label: "beach", describe: "the sandy beach shoreline with palm trees" },
      { id: "jetski", label: "player", describe: "the jet ski and its rider" },
    ],
    stages: [
      {
        id: "reach_buoy",
        title: "Reach the red buoy",
        target: "buoy",
        done:
          "In the LAST image, is a red buoy directly beside the jet ski, within a few boat lengths? A buoy far in the distance does not qualify.",
      },
      {
        id: "land",
        title: "Land on the beach",
        target: "beach",
        done:
          "In the LAST image, has the jet ski reached the shoreline, with sand or the water's edge directly in front of or beneath it? Seeing the beach in the distance does not qualify.",
      },
    ],
  },
];
