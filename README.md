# ASHGROVE

A PS1-styled wave-survival FPS set in a procedurally generated small town.
Everything — the street layout, every building, every interior, every texture,
every sound — is generated at load time from a single integer seed. No art
assets, no audio files, no dependencies, no build step.

The original design brief lives in [`docs/BRIEF.md`](docs/BRIEF.md); the
decisions taken to satisfy it are written up in
[`docs/DESIGN.md`](docs/DESIGN.md).

---

## Running it

ES modules need to be served over HTTP, not opened from disk.

```sh
npm start                 # serves on :8080 and opens a browser
# or any static server:
python3 -m http.server 8080
```

Then open <http://localhost:8080/>. Requires WebGL2.

Query parameters:

| Parameter    | Values                          | Effect                                  |
|--------------|---------------------------------|-----------------------------------------|
| `seed`       | any integer                     | Regenerates the entire town             |
| `preset`     | `authentic` `soft` `clean`      | How hard the PS1 filter is applied      |
| `difficulty` | float, default `1`              | Scales wave size and damage             |

`?seed=88888` is a notably larger town; `?preset=clean` disables the vertex
wobble and affine warping if you want to look at the level design directly.

## Controls

| Key                | Action                                            |
|--------------------|---------------------------------------------------|
| `W` `A` `S` `D`    | Move                                              |
| `Shift`            | Sprint (drains stamina)                           |
| `Ctrl` / `C`       | Crouch                                            |
| `Space`            | Jump                                              |
| Mouse / `LMB`      | Look / fire                                       |
| `RMB`              | Aim down the scope (hunting rifle)                |
| `R`                | Reload                                            |
| `1`–`5`, wheel, `Q`| Switch weapon                                     |
| `E`                | Take the highlighted item                         |
| `F`                | Flashlight (battery drains while lit)             |
| `F2`               | Cycle render preset                               |
| `F3`               | Performance overlay                               |
| `Esc`              | Release the cursor                                |

## Playing

Waves arrive on a timer; between them you have half a minute to loot houses and
shops. The infected come out of the town rather than out of thin air — closets,
stockrooms, alleys, wrecked cars — and they spawn out of your line of sight.
There are five types: shamblers, workers, runners, crawlers, riot officers, and
the hulk, which you should not fight in the open.

You start with a crowbar and a pistol with unlimited reserve ammunition.
Everything else — the SMG, the pump shotgun, the hunting rifle, medkits, armour
— is inside buildings. The town is the ammunition economy.

Navigate by landmarks, not by a map. The compass strip names what you can see:
the water tower on the eastern rise, the town square, the clock tower.

## Repository layout

```
index.html               boot page and loading screen
src/
  core/     math.js      seeded RNG, noise, mat4, 2D polygon surgery
            input.js     keyboard, mouse, pointer lock
            audio.js     every sound, synthesised at runtime
  render/   gl.js        WebGL2 helpers, texture arrays, vertex layout
            shaders.js   vertex snapping, affine mapping, dither, sky
            meshbuilder.js  geometry accumulation with baked vertex light
            renderer.js  the frame
            font.js      5x7 bitmap font for the HUD
  art/      texgen.js    the procedural texture painter
            materials.js the material library and building style kits
  world/    config.js    every tunable that shapes the town
            roads.js     organic street growth, planarisation, city blocks
            plan.js      zoning, lot subdivision, building programme
            building.js  walls with real openings, roofs, trim, foundations
            interior.js  floor plans, partitions, fit-out
            props.js     furniture and street infrastructure
            world.js     assembly, collision, lighting, spawn points
  game/     collision.js 2.5D segment/floor collision world
            nav.js       town-wide flow field
            player.js    movement, camera, condition
            weapons.js   the arsenal and viewmodels
            actors.js    the infected: animation, AI, bodies
            director.js  wave pacing
            hud.js       the overlay
            game.js      the loop that owns everything
  main.js                boot and frame scheduling
tools/                   development harnesses (see below)
```

## Development tools

These run in Node with no browser — the world generator has no GL dependency,
which makes it directly testable.

```sh
node tools/validate.mjs 8        # build 8 towns, assert the brief's hard rules
node tools/build-world.mjs 42    # build one town, print geometry budgets
node tools/plan-preview.mjs 42 plan.svg   # render the street plan as SVG
node tools/smoke.mjs /tmp/shots  # boot headless Chromium, screenshot the game
```

`validate.mjs` is the useful one: it asserts the scarcity rules (exactly one
library, at most two churches, three to five filling stations, dozens of
houses), that every building has a front door, that the room behind that door is
actually reachable on foot from the player's start, that the collision world is
populated, and that the triangle budget holds. All eight reference seeds pass.

That reachability check earned its keep immediately — it found that the
navigation grid was coarser than a doorway, which had silently sealed every
interior in the town.
