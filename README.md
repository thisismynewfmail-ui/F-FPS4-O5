# ASHGROVE

A PS1-styled wave-survival FPS set in a procedurally generated small town in a
valley. Everything — the ground it stands on, the street layout, every
building, every interior, every texture, every sound — is generated at load
time from a single integer seed. No art assets, no audio files, no
dependencies, no build step.

The town opens outward from the market square in six sectors as your kill
count crosses five milestones. It is ringed by a quarantine cordon that was
thrown up in stages and never came down; what opens is the gates in it, and
nothing on screen tells you when. A shutter is up that was down.

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

The start screen and the browser console both print a build stamp. Browsers
cache ES modules aggressively, so if behaviour does not match the newest commit,
check the stamp and hard-reload (`Ctrl`/`Cmd`+`Shift`+`R`). `npm start` serves
with caching disabled; `python3 -m http.server` does not.

Query parameters:

| Parameter    | Values                          | Effect                                  |
|--------------|---------------------------------|-----------------------------------------|
| `seed`       | any integer                     | Regenerates the entire town             |
| `preset`     | `authentic` `soft` `clean`      | How hard the PS1 filter is applied      |
| `difficulty` | float, default `1`              | Scales wave size and damage             |
| `mirrorx`    | `1` / `0`                       | Mirror horizontal look + strafe (off)   |
| `inverty`    | `1` / `0`                       | Invert vertical look                    |
| `sens`       | float, default `0.0022`         | Mouse sensitivity                       |

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
| `F3`               | Performance overlay (shows the horizontal sense)  |
| `F4`               | Flip horizontal look + strafe for this session    |
| `Esc`              | Release the cursor                                |

## Playing

Waves arrive on a timer; between them you have half a minute to loot houses and
shops. The infected come out of the town rather than out of thin air — closets,
stockrooms, alleys, wrecked cars — and they spawn out of your line of sight,
and never from behind a cordon you have not opened. There are five types:
shamblers, workers, runners, crawlers, riot officers, and the hulk, which you
should not fight in the open.

You start with a crowbar and a pistol with unlimited reserve ammunition.
Everything else — the SMG, the pump shotgun, the hunting rifle, medkits, armour
— is inside buildings, and only inside the sectors that are open. The town is
the ammunition economy, and the next sector is the reason to want it.

Navigate by landmarks, not by a map. The compass strip names what you can see:
the water tower on Ashgrove Ridge, the market square, the clock tower, the gate
out of the sector you are standing in.

### Sectors

| Sector | Opens at | What is in it |
|--------|----------|---------------|
| The Square       | —     | The market cross, four streets, and nothing else |
| Market Row       | 500   | The commercial core, the shopfronts, the alleys |
| Beacon Terraces  | 1200  | The civic quarter and the hill streets |
| The Warrens      | 2500  | Housing, allotments, and the Hollow |
| Millgate         | 4500  | The works, the container yard, the rail head |
| Ashgrove Out     | 7000  | The ridge, the fields, and across the water |

Each cordon is made of whatever was to hand the week it went up: welded cars,
then police barricades, then contractors' hoarding, then precast concrete,
then an earth berm. The gates match — a coach dragged aside, a roller shutter,
a chain-link gate, a lift barrier, a bascule bridge over the Ash.

### The ground

The valley is a heightfield, not a plane. Ashgrove Ridge carries the water
tower and the best firing position on the map; Beacon Hill is terraced housing
on switchback streets; the Hollow is a worked-out clay pit with one ramp in;
the Ash cuts the south-west and is the map's edge until the bridge comes down.
Going uphill costs you speed and costs the infected the same, so high ground is
worth taking and worth losing.

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
            terrain.js   the heightfield: landforms, road grading, pads
            roads.js     organic street growth, planarisation, city blocks
            plan.js      zoning, lot subdivision, building programme
            building.js  walls with real openings, roofs, trim, foundations
            fit.js       resolving overlaps once every neighbour exists
            interior.js  floor plans, partitions, fit-out
            props.js     furniture, street infrastructure, vegetation
            districts.js the six sectors and the progression state
            cordon.js    the quarantine rings, their gates, the bridges
            secrets.js   twelve things nobody tells you about
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
node tools/smoke.mjs /tmp/shots  # boot headless Chromium, play, screenshot
node tools/tour.mjs /tmp/tour 42 # screenshot every gate, landmark and secret
```

`validate.mjs` is the useful one. It asserts:

* **Scarcity** — exactly one library, at most two churches, three to five
  filling stations, dozens of houses.
* **Geometry** — no building mass overlaps another building, none stands in the
  carriageway, no vehicle clips a wall, no front door opens into a neighbour,
  every front door faces a street, and no outdoor prop stands in a living room.
* **Ground** — at least 10 m of relief in every sector, no carriageway over its
  class's grade limit, and the ground mesh never punching up through the paving.
* **Reachability** — the room behind every front door is reachable on foot; the
  opening sector is whole with the cordon shut; nothing past the first cordon is
  reachable while it is shut; and every sector is enterable once it opens.

All eight reference seeds pass. Two of these earned their keep immediately:
the reachability check found that the navigation grid was coarser than a
doorway, which had silently sealed every interior in the town, and the overlap
check found forty-four pairs of buildings standing inside each other.

`tour.mjs` is the other half of the story: it drives the camera to each cordon
gate in both states, to every landmark and to every secret, because a random
walk almost never happens to stand in front of the thing you just changed.
