# Jev World

**A decision model plays games inside a world model.**

[LingBot World 2](https://www.reactor.inc) generates an interactive video world from one image and a prompt, in real time. [Jev](https://openrouter.ai/docs/guides/community/jev) — TypeSafe's decision model — watches that video and plays it. A second agent (Claude) designs the levels.

There's no game engine underneath. The key, the door and the buoy exist only because the prompt says so. "Picking up the key" means weaving a sentence into the prompt, and whether it worked is up to Jev looking at the next frames. This repo is a harness for finding out how far that goes.

```
 ┌──────────────┐  level JSON   ┌───────────────────────────────────────────┐
 │  Designer    │──────────────▶│  Arena (browser)                           │
 │  (Claude)    │  world prompt │                                           │
 │  image+theme │  targets      │   LingBot World 2 ──video──▶ canvas ◀── HUD │
 └──────────────┘  stages       │        ▲                       │           │
                                │        │ move / turn /         │ 2 frames  │
                                │        │ prompt clauses        ▼           │
                                │   player loop ◀──decision── Jev (/decisions)│
                                └───────────────────────────────────────────┘
```

## How it works

**Levels** (`lib/level.ts`) are the contract between the agents:

- `prompt.base / moving / still`: the world LingBot should generate
- `targets`: things to track. Jev draws a bounding box around each one every tick.
- `stages`: ordered objectives. Each has a strict visual `done` check. An interaction stage also has a `ready` check and an `interaction` with an `event` clause (played for ~5s) and an `after` clause (the new, persistent world state).

**Each tick** the app sends Jev the last two frames and one [Decisions](https://openrouter.ai/docs/guides/community/multimodal-decisions) request (`app/api/jev/route.ts`):

| question       | type     | used for                                           |
| -------------- | -------- | -------------------------------------------------- |
| `action`       | `choice` | control to hold until the next tick (W/S/A/D/←/→/interact/wait) |
| `box:<target>` | `box`    | bounding box overlay                               |
| `seen:<target>`| `noul`   | hide boxes for targets that aren't visible (`box` always returns one) |
| `ready`        | `noul`   | gate interactions: refused unless ≥ 0.55            |
| `done`         | `noul`   | stage completes after 2 consecutive ticks ≥ 0.7    |
| `blocked`      | `noul`   | HUD / debugging                                    |

**The overlay** (`lib/overlay.ts`) draws the live frame, Jev's boxes, the action probabilities and the objective checklist onto one canvas. **● Record** captures that canvas to MP4/WebM, so the demo video is a recording of exactly what you see.

## Quick start

```bash
cp .env.example .env.local   # add REACTOR_API_KEY and OPENROUTER_API_KEY
pnpm install
pnpm dev
```

Open http://localhost:3000, click **Connect**, pick a level, then **▶ Let Jev play**. With Jev off you can drive with WASD and ←/→ to scout a level yourself.

To make a new level, choose a starting image (or upload your own), optionally type an idea, then press **✦ Design a level**. Designed levels are saved in localStorage. The JSON is visible under **Level JSON**, so you can copy a good one into `lib/levels.ts`.

| env var              | default                     |                                     |
| -------------------- | --------------------------- | ----------------------------------- |
| `REACTOR_API_KEY`    | —                           | LingBot World 2 sessions            |
| `OPENROUTER_API_KEY` | —                           | both agents                         |
| `JEV_MODEL`          | `typesafe/jev-1.14`         | 1.14+ is required for `box`         |
| `DESIGNER_MODEL`     | `anthropic/claude-opus-5.5` | any OpenRouter vision chat model    |

## Experiments

The point is to find what works. Ideas, roughly from easiest to hardest:

- **Navigation** — reach a landmark (*Buoy Run*). Tests `choice` steering plus `box` tracking.
- **Fetch & use** — key → door (*Key to the Neon Door*). Tests whether LingBot keeps an injected object stable, and whether Jev's `ready` gate stops early "interactions".
- **Ordering puzzles** — light three braziers in a specific order. Tests multi-stage state carried only in the prompt.
- **Driving** — keep a car on the road through turns. Tests closed-loop control at Jev's decision rate.
- **Adversarial designer** — the designer tries to write levels that are *possible but hard*, and the scores feed back into the next design.
- **Judge vs. world** — when a stage fails, was it Jev misjudging, or LingBot never rendering the outcome? Record both and label them.

Log findings below as you go.

| level | result | notes |
| ----- | ------ | ----- |
|       |        |       |

## Caveats

- Jev's image input and `box` are early ("Dreamer-ready") features and may change.
- The API routes are meant to run locally. Add auth before you deploy this anywhere public, because both routes spend your keys.
- Starter scene images come from the LingBot World 2 reference app.
