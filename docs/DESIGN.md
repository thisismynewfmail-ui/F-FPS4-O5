# Design notes

How the brief in [`BRIEF.md`](BRIEF.md) was interpreted and built. Section
numbers below follow the brief's own.

---

## 0. The shape of the thing

The brief asks for two aesthetics at once: "2007 Half-Life 2 visual style" and
"strict PS1 hardware limitations". Those are eight years and roughly two orders
of magnitude of triangles apart, so they were split by concern:

* **Rendering** is PS1: vertex snapping, affine texture mapping, baked vertex
  light, 320×240 internal resolution, ordered dither to 15-bit colour.
* **Level design language** is Source-era: real interiors, functional doors and
  windows, sightlines cut deliberately, cover placed for a firefight, landmarks
  for orientation.

The reference images agree with this reading — they are Half-Life 1, Quake, and
Duke Nukem, which is where those two lineages actually meet.

Everything is procedural because the brief asks for a *system*: rules about
scarcity, zoning, weathering gradients and fenestration are far better expressed
as a generator than as hand-placed props. A seed produces the whole town
deterministically, which also means the rules can be tested (`tools/validate.mjs`).

## 1. The PS1 look, done honestly

Four techniques carry it, all in `src/render/shaders.js`:

**Vertex snapping.** The GTE had no sub-pixel precision, so vertices landed on
integer screen coordinates. Clip-space XY is quantised to a coarse grid before
the perspective divide. This is what makes geometry swim as the camera moves.

**Affine texture mapping.** The console had no perspective-correct
interpolation. GLSL ES 3.00 has no `noperspective` qualifier, so the hardware's
correction is cancelled algebraically: emit `uv*w` and `w` as varyings and
divide in the fragment shader. The hardware interpolates `(uv·w)/w = uv`
linearly in screen space and `w/w = 1` likewise, so the ratio is exactly the
screen-linear UV. Textures warp across large triangles as they did in 1997.

That warping is also why geometry is subdivided to a maximum edge length —
exactly the reason PS1 developers subdivided theirs. Ground planes are the worst
case (grazing angles, large polygons) and get the finest tessellation.

**Vertex lighting.** All static light is baked per vertex at build time by a
probe (`makeProbe` in `world.js`): a sky/ground hemisphere plus one unshadowed
sun, darkened when enclosed, plus local lights. Nothing is per-pixel except the
player's flashlight, which needs smooth falloff to be playable.

**Low resolution and dither.** The scene renders to a 320×240 target, is
dithered to 15-bit colour with the classic 4×4 Bayer matrix, gets scanlines,
grain and a vignette, then point-upscales. `F2` cycles three presets so the
level design can be inspected without the filter.

The whole world draws from a single 128×128 texture array — the modern
equivalent of the PS1's texture-page discipline — with alpha *testing* rather
than blending, so the pass is order-independent and needs no sorting.

### Cosmic horror without monsters

The brief is explicit that the horror must not be supernatural. It comes from:

* **Proportion.** Commercial storeys are 3.9 m, residential 3.05 m, industrial
  up to 7.4 m. Standing in a warehouse you are the wrong size.
* **Light.** Interiors bake to 21% of outdoor light. Rooms brighten toward their
  windows and go black in the middle of the plan, so every building has a dark
  centre you have to walk into.
* **Sound.** Two detuned drones a semitone apart under a wind bed, rising with
  the director's stress value, plus distant groans on a random timer. Nothing is
  ever quite silent and nothing is ever quite in tune.
* **Absence.** The town is fully furnished and completely empty. The beds are
  made, the shelves are half-stripped, the cars are stopped in the road.

## 2. Urban planning

The brief forbids grid symmetry *and* random scatter. The generator gets its
shape from history instead (`src/world/roads.js`):

1. A crossroads exists first — the church and the market square sit on it.
2. Two arterials run through it, meandering rather than following a compass.
3. A mill road strikes out toward the rail head; the industry never left.
4. Secondary streets branch at irregular intervals and angles, **snapping** to
   whatever they run into. That snapping is what produces T-junctions and
   irregular blocks instead of a grid.
5. Residential lanes branch again; some dead-end in cul-de-sacs, the rest loop
   back and reconnect.
6. Service alleys are cut through the deepest downtown blocks last.
7. Any block still too deep to reach from the street gets a road cut through it,
   repeatedly — which is what real towns did.

The result is planarised (every crossing becomes a real node) and the faces of
the planar graph are extracted as city blocks. Face extraction is exact: block
areas sum to the map area to within rounding.

Zones are concentric and organic, with noise-wobbled radii so nothing reads as a
circle: commercial core on the crossroads, mixed fringe, residential ring,
industry banished to the eastern edge against the rail line, farmland beyond.

**Scarcity is enforced, not hoped for.** `PROGRAMME` in `plan.js` is a table
with hard caps. Capped civic buildings are placed first on the lots that suit
them best, with a relaxation ladder so a hard minimum is met even on an awkward
road layout. Across eight reference seeds: exactly one library, one or two
churches, exactly three filling stations, and 53–107 homes.

### Lots

A block is cut into lots the way a surveyor would (`subdivideBlock`). A block
deeper than about two lot-depths is first split *along* its long axis into two
rows backing onto each other — which is why terraced streets have back gardens
meeting in the middle. Each row is then sliced *across* into frontages.

Doing it in that order means every buildable lot keeps a street edge. That
single property is what later guarantees front doors face the street: it is
structural, not a placement heuristic.

## 3. Buildings

Every wall is a **shell** — outer skin, inner skin, and reveals connecting them
through each opening. There are no flat facades anywhere; you can stand in a
doorway. Openings are cut by building a grid over the union of every opening's
edges and emitting only the cells that are not inside one.

**Doors face the street** because a building's local +Z axis is *defined* as
"into the lot". The front wall is by construction the one on the frontage edge.
Front doors are placed in the room the plan marked as the entry, so they open
into circulation space rather than a bedroom.

**Windows align with rooms** because the floor plan is generated *first*. Each
room then claims the spans of exterior wall it actually touches, and windows are
placed only inside those spans, sized by what the room is for — a bathroom gets
one small high light, a kitchen gets a wide one at counter height, a shopfront
gets full glazing. Look through a kitchen window and you are looking at the
kitchen.

**Roofs match the footprint exactly** because they are generated from the same
rectangles the walls were. The climate is cold and wet, so residential roofs are
gabled or hipped at 32–46° with deep eaves, guttering and downspouts;
commercial roofs are flat with parapets, coping stones, HVAC plant, vents and a
roof hatch; industrial roofs are low-slope shed or flat. Chimneys are placed
over the fireplace the floor plan reserved.

**Foundations and trim** exist on every structure: a plinth of poured concrete,
brick or stone; corner boards; a water table; storey bands on commercial blocks;
fascia and soffits. That is what breaks the silhouette at low resolution.

Secondary massing — rear wings, garages, porches, towers — is what stops every
house being a box.

## 4. Materials

`src/art/texgen.js` is a small painting library: brick with running bond and
per-brick colour variation, lap siding with a hard shadow under each board,
ashlar stone, troweled stucco, formed and CMU concrete, asphalt shingle, clay
pantile, corrugated metal, built-up roofing, chain-link, foliage cards, glass
with reflection bands and shatter webs, doors, windows with real mullions.
Everything tiles seamlessly and is quantised to a small palette so it reads at
PS1 resolution.

`materials.js` builds ~30 distinct wall treatments — different bond patterns,
board pitches, aggregate, colour — each generated in a clean and a weathered
state, plus separate texture sets for roofs, trim, foundations, doors, windows,
ground, markings, interiors, props, signage and the infected. 248 layers total,
kept under the 256 the WebGL2 spec guarantees.

**Weathering is a parameter, not a texture.** `decay` runs 0..1 from the
maintained commercial core to the rotten outskirts, with local noise so
neighbours differ, and drives moss creeping up from the base, rust blooms,
streak stains, peeling paint over a different undercoat, and cracking. The same
brick material therefore produces a crisp downtown variant and a ruined edge-of-
town one. Buildings past the halfway point also get broken and boarded windows.

Style kits pair a wall with trim, roof, foundation, door and window choices, and
are then varied per building, so no two neighbours share a full material set.

## 5. Interiors

Floor plans are binary subdivisions of the footprint, typed by position: front
rooms are public (living, retail, lobby), back rooms are service (kitchen,
stock, workshop), the smallest leftover is the bathroom. Room sizes were tuned
until they were sizes people actually live in — an earlier pass produced
believable-looking plans full of 8 m² cupboards and tripled the cost of every
interior for nothing.

Partitions are real geometry with real doorways. A union-find pass guarantees
every room is reachable, which matters for enemy pathfinding as much as for the
player, and a few extra openings create loops so combat has flanking routes.
Multi-storey buildings get stepped staircases, registered as nav links.

Fit-out is per room type and wall-aware: beds against walls with a nightstand
beside them, counters running the longest clear wall with the sink under a
window, aisles of shelving in shops with a register by the door, machinery and
pallets on a workfloor, pews facing an altar in the church. Cover, loot points
and enemy spawn points fall out of the furniture: closets, stockrooms, lockers
and dark corners are where the infected are standing when you open the door.

## 6. The urban core

Road classes carry real widths — arterial 13 m, main 11 m, street 8.4 m, lane
6.4 m, alley 4.2 m — with matching pavements. Junctions get crosswalks,
signals and stop signs; arterials get lane markings.

Road surfaces are built as a convex pad at every junction plus a quad for the
stretch of each edge between its two pads. Nothing overlaps by construction,
because overlapping coplanar road quads z-fight, and the terrain plane beneath
covers any hairline seam.

The town square, two or three parks and an industrial container yard are chosen
before lot subdivision and never built on. The square holds the statue that
orients you downtown; the container yard is a stacked maze that plays completely
differently from the open plaza.

Wayfinding is by landmark, as the brief asks: the water tower on the eastern
rise, the church spire, the clock tower on the town hall, the statue on the
square. The compass strip names them and gives a distance — it deliberately is
not a map.

## 7. Street-level detail

Furniture is walked along the kerb line at irregular intervals, weighted by
zone: parking meters, newspaper boxes, bus shelters with shattered glass and
rotting benches, phone booths, planters, bollards, leaning street signs,
hydrants (some knocked over, some broken), manholes (some displaced, faintly lit
from the sewer below), utility poles with catenary wires drooping between them,
dumpsters, jersey barriers and hazard drums in the industrial belt. Traffic is
abandoned in the road, thickest downtown.

All of it is placed against the kerb, faces the road, and doubles as low cover.

---

## Engineering notes

**Collision** is 2.5D: vertical wall segments with height ranges, plus
horizontal floor plates. Buildings are rotated to face their streets, so
axis-aligned boxes were never an option; segments handle rotation, doorways
(which are simply gaps in the segment list), multi-storey interiors and rooftops
with one representation.

**Navigation** is a town-wide flow field recomputed a few times a second from
the player's position. A hundred infected each get a correct route through
winding streets and open doorways for the cost of one array lookup, with local
steering for the last couple of metres so they shoulder past each other in
doorways instead of walking in single file.

**The director** is modelled on Left 4 Dead rather than a fixed spawn table. It
tracks proximity, crowd size and player health into a stress value and decides
when to squeeze and when to let go. Waves escalate, but within a wave the
pressure breathes. Spawns are always out of sight, beyond a minimum distance,
and biased toward interior points when the player is indoors.

**Budgets.** ~1.3M static triangles across 144 chunks, frustum- and
fog-distance-culled to roughly 400k visible; textures generate in ~1.3 s and the
town in ~3–6 s. The whole load is under five seconds.

### Things that were wrong and got fixed

Recording these because they were all silent — the code ran and produced
plausible-looking output while being wrong.

* `polyInset` used the outward normal, so "buildable" block polygons were being
  *expanded* across the streets rather than inset. Buildings were being placed in
  the road and 70% of footprints were failing a sanity check.
* `mat4View` built a left-handed basis pointing along −Z, so the camera was both
  mirrored and facing backwards relative to the AI and movement code.
* `Tex.idx` did not truncate coordinates, so every sub-pixel drawing operation
  wrote to a fractional array index — which a TypedArray silently ignores. Blobs,
  cracks and stains were drawing nothing at all.
* The tinted branch of `Tex.mottle` treated its 0..255 amount as a 0..1 blend
  factor, driving `clamp01` to 1 across half of every weathered texture. The
  entire world was buried under solid grime; fixing it was the single largest
  visual improvement in the project.
* Rebinding `ELEMENT_ARRAY_BUFFER` while a VAO was bound rewrote *that VAO's*
  index binding, corrupting the previous mesh every frame.
* `polyFlatTess` sliced polygons with Sutherland–Hodgman half-plane clipping,
  which on a concave subject emits zero-width bridge edges; ear-clipping those
  produced long slivers that smeared ground textures into wedges across whole
  blocks. It now triangulates first and refines each triangle.
