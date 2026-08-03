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

The HUD is deliberately *not* drawn into that target. It is laid out in a
virtual space derived from the canvas at an integer scale, so the 5×7 font still
lands on exact pixel boundaries but the overlay keeps a constant physical size
whichever render preset is active.

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

## 1b. The ground

The first version of this town was flat, and being flat was the single largest
design failure in it. Flat ground removes every reason to choose one route over
another; it makes a crowd of a hundred read as one silhouette at one height; and
it means no position is worth holding, because every position is the same
position. So the whole map is now a heightfield (`src/world/terrain.js`), and it
is authored for play first.

**Four landforms carry it.** Ashgrove Ridge is a spine down the eastern third
with the water tower on it — the best firing position on the map and the most
exposed place on it. Beacon Hill is a dome in the north-west that the
residential terraces climb, so a chase uphill is slow and a retreat downhill is
fast and dangerous. The Hollow is a worked-out clay pit, steep on three sides
with one shallow ramp: cover from rifle fire, a trap if you take it. The Ash is
a river valley cutting the south-west, and it is the hard southern edge of the
map until the bascule bridge comes down.

**It is stamped, not evaluated.** A closed-form height function cannot produce
a town, because roads and buildings have to *conform*: a carriageway that
follows raw noise is a rollercoaster, and a house on a 6% slope has either a
floating corner or a basement. So the field is built in passes — landforms,
then road corridors after every junction has been given an elevation that
satisfies its road class's maximum grade, then building pads keyed to the door
each building fronts onto, then relaxation of everything that was not stamped so
that cut and fill blend into the hillside instead of terracing.

Grade limiting is what makes the hill streets work. An arterial may not exceed
5.5%; a back lane may reach 15.5%. Laid straight over Beacon Hill a street would
hit 30%, so the relaxation pass drags the junctions until it does not, and what
comes out the other side is a street that switches back across the slope — which
is what real hill towns did, for the same reason.

**Everything samples one function.** `Terrain.heightAt` is the only authority on
where the ground is. Surfaces drape over it, props stand on it, collision drops
onto it, bullets bury into it, the navigation grid prices its slope, and the
player's speed is charged against the grade they are actually attacking. Nothing
carries its own idea of zero, which is the single rule that keeps a heightfield
town from coming apart.

### The bug this created, and the fix

Roads, pavements and lot ground all drape over the same field with *different*
tessellations, and two triangulations of the same bilinear patch disagree by up
to seventy centimetres in the middle of a cell. The terrain punched up through
the carriageway in blotches and whole streets read as grass — which looks like a
texturing mistake and is not one.

Two things fix it, and only the second is principled. The field origin is
snapped so that its grid is in phase with the world-aligned grid the ground mesh
is clipped on, which makes every other ground vertex an exact field sample. Then
the ground mesh is sunk below the height function by an amount computed from the
field's own curvature: the bilinear cross-term `a = y00 + y11 − y01 − y10`
bounds the triangulation error at `|a|/16`, so the sink is that plus a small
constant plus a term proportional to how heavily the spot was paved. That last
term is not about error at all — it gives the road, the footway and the lot
ground room to stack in the order they are laid, and because it fades out
exactly where the paving does, there is never a visible lip where they meet.

`validate.mjs` reproduces the ground mesh's own triangulation and asserts the
clearance is positive everywhere, on every seed. A constant that happened to
work on the seeds someone looked at would have been indistinguishable from a
correct one right up until it wasn't.

## 1c. Progression

The town opens in six sectors at 500, 1200, 2500, 4500 and 7000 kills. 500 was
the given reference point; the rest scale by roughly 2.4x, 2.1x, 1.8x and 1.55x,
so each sector takes longer in absolute terms and less than proportionally
longer in practice, because by the fourth one you have the shotgun and the high
ground.

The boundaries are concentric because the town is concentric — it grew out from
the crossroads, so the ring you are in tells you how old the buildings around
you are and what they were for. The radii are wobbled by low-frequency noise so
no boundary reads as a circle on the ground.

**What stops you is a cordon, and the cordon never comes down.** Five rings,
each in whatever was to hand the week it went up: cars welded nose to tail, then
police barricades, then contractors' hoarding, then precast concrete, then an
earth berm. Where a ring meets a building it is not built, because they used the
building — and where it runs *through* one, the corridor is packed floor to
ceiling with furniture and brick.

Only the gates open. Each gate is built twice, shut and open, into two separate
chunk stores, and only the shut state registers collision under a tag; opening a
sector is one collision sweep and a flag flip per mesh. There is no interface
for it anywhere. A shutter winds up into its drum. A bascule bridge comes down
over the Ash. A coach welded across Mill Street is dragged onto the pavement,
leaving the scrape marks and the bar they levered it with. If the player happens
to be looking the right way they see it happen; if not they find it open later
and never know when.

The one concession is a sound — a metal groan and a rumble, spatialised from the
gate's real position with a very long reference distance, so it carries across
the valley and tells you which way to go without anything on screen saying so.

### Why the cordon kept not working

Three separate bugs, each of which left a town that *looked* walled and was not,
and none of which is visible in a screenshot:

* The panels were built at right angles to the ring. Every barricade is authored
  as a box along local +x, and the transform stack maps local +x to
  `(cos yaw, −sin yaw)` — not to `(sin yaw, cos yaw)`, which is the *forward*
  convention the rest of the game uses for headings. Using the heading produced
  a ring of two-metre walls each pointing outward with two-metre gaps between
  them.
* A gate's collision was one long segment referenced to the ground at its
  centre. On a cambered road its ends sat below the verge, and the navigation
  grid — which quite correctly asks whether a wall is tall enough to matter
  *here* — walked straight round it. Gates are now built in two-metre pieces,
  each referenced to the ground under it.
* The doorway-carving pass, which exists to punch building openings back open
  after wall rasterisation seals them, was also punching the cordon open
  wherever it ran through a building. The cordon is now re-rasterised last and
  wins; the tag is what makes it identifiable as "may not be carved".

The validator now floods the map twice, once with every gate shut and once with
them all open, and asserts both that the opening sector is whole and that
nothing past the first cordon is reachable while it is shut.

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

**The elevation is then resolved as a whole**, which it originally was not.
Windows come from the floor plan and the entrance comes from the entry room, and
neither knows about the other; where the entry room's centre sits near a party
wall, the door lands inside a neighbouring room's window. `wallShell` cuts the
union of two overlapping openings as a single hole, so the *wall* was always
right — but both panels were then drawn into it, and the door read as a
rectangle of painted timber sitting on top of the glass. On the reference seed
that was happening 270 times.

A real elevation has a pier of wall between every opening and a return at every
corner, so that is now the rule: openings are accepted in priority order —
doors, then by storey, then largest first — and any that would collide with one
already accepted in *both* axes is dropped. Both axes, because a fanlight
directly above a door is fine and two windows a hand's width apart at the same
height are not. Doors are slid along the wall rather than dropped; a house may
lose a window, it may not lose its door. The same resolved list then drives the
geometry, the collision and the baked window light, so all three agree about
what was actually cut. The fascia band on a shopfront is sized from the top of
the glazing for the same reason, and posted notices are pinned to a pier.

`validate.mjs` checks every pair of openings on every elevation of every
building, which is how this class of mistake stays fixed.

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

**Buildings sit on pads.** A pad is keyed to the elevation at the front door,
so the path from the pavement is never a step and the fall of the site is taken
at the back. How far the natural ground drops away under the footprint decides
how tall the plinth is, which on the hill streets is most of what you actually
see: a house whose front step is at pavement level and whose back wall stands on
two metres of stonework. Where a whole block's interior stands above the footway
the difference is held by a retaining wall — with a flight of steps wherever a
front path or a driveway crosses it, because a retaining wall without them is
the fastest way to seal every door on the street.

### Nothing may be inside anything else

`computeFootprint` sites a building from the extremes of its own lot in the
building's own frame. That is the right way to do it and it is not sufficient,
for two reasons that only appear once the whole town exists: a lot cut from an
irregular block is often a wedge, so its bounding box in that frame is strictly
larger than the lot; and a building knows nothing about its neighbours when it
is placed. On the reference seed that left forty-four pairs of buildings
standing inside each other and thirty-five masses in the carriageway.

From the street both look like an odd corner. `src/world/fit.js` runs after
every footprint exists and resolves them in order of what they cost: pull a mass
back toward its own lot, delete an offending porch or garage, shrink a main mass
in small steps, and only as a last resort abandon the building and leave the lot
as a yard. It costs about a tenth of the buildings and the result is exactly
zero overlaps on every seed, which `validate.mjs` asserts.

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
Trees come up through the paving at intervals with the kerb broken around them,
which is the detail that sells it.

## 8. Nature, and how it moves

Vegetation is woven through the town rather than kept in a park, and the rules
are the ones the weather actually imposes. Ivy climbs the elevations that face
away from the sun, because that is where the damp sits — this town's sun is
south-westerly, so a player who notices can tell which way they are facing from
the walls alone. Weeds take the base of every wall, where the rain runs off the
roof and nobody ever swept. Buddleia takes the gutters of the neglected blocks.
Bushes gather on every block boundary, where a fence stopped the mower.
Overgrown lots get the tallest grass on the map, which is what signals unwalked
ground.

**All of it sways, and the entire animation system is one float per vertex.**
`aWind` is how far a vertex may be pushed by the wind, in metres: zero on
everything structural, non-zero only on the tops of foliage cards. The vertex
shader adds two sines a prime ratio apart, phase-shifted by world position so no
two plants are in step, times a slow gust that sweeps across the map as a
travelling wave. No skinning, no per-object update, nothing on the CPU at all.
That is how the era did it, and at 320x240 it is indistinguishable from anything
more expensive.

The scale matters more than the technique: a tree crown travels 30 cm, a hedge
14, a tuft of grass 10. Anything past about a third of a metre stops reading as
wind and starts reading as a physics bug.

## 9. Secrets

Twelve, deliberately of three kinds, because a map where every secret is a loot
cache teaches the player to stop looking once they have the gun.

* **Rewarding.** A fire escape up the back of a downtown block — the only free
  way onto a roof, which is the safest ground in the game. A coal cellar under a
  hill house, reachable only from the back where the ground has fallen away. A
  sewer chamber under a junction whose manhole has had its cover levered off; the
  faintly glowing manholes elsewhere were always hinting at it. A dry well with
  the rope still reaching the bottom. A maintenance stair up the water tower to a
  platform somebody lived on for a while. A public stair on the hill where the
  seventeenth tread is the wrong stone.
* **Observational.** Nothing to take. A ring of thirteen stones at the bottom of
  the Hollow, evenly spaced, built after everything else stopped. A brick room
  behind a building with no door on any side and the light on inside. A car with
  its headlamps burning and both doors open. Two parlours at opposite ends of the
  map furnished identically down to the position of the overturned chair. A
  lattice mast whose red lamp is still being paid for.
* **Conditional.** A boarded house in the Beacon Terraces whose planks are on the
  path when the third cordon opens. Nobody boarded it and nobody unboarded it.

---

## Engineering notes

**Collision** is 2.5D: vertical wall segments with height ranges, plus
horizontal floor plates. Buildings are rotated to face their streets, so
axis-aligned boxes were never an option; segments handle rotation, doorways
(which are simply gaps in the segment list), multi-storey interiors and rooftops
with one representation.

**Navigation** is a flow field recomputed a few times a second from the player's
position. A hundred infected each get a correct route through winding streets
and open doorways for the cost of one array lookup, with local steering for the
last couple of metres so they shoulder past each other in doorways instead of
walking in single file.

On a heightfield it also prices slope: a bank is expensive, a cliff is as solid
as a wall, and deep water is impassable. That is what makes the horde pour down
the streets and around Beacon Hill rather than straight over it, and it is why
holding the high ground works — the infected have to come the long way, and they
climb slower than they walk, by the same rule the player does.

Two subtleties the heightfield forced. Whether a wall obstructs is a question
about its height *above the ground at that point*, not about its absolute
height; using the absolute figure silently un-blocks every wall standing on high
ground. And furniture is tagged separately from walls, because a one-metre grid
cannot tell a wardrobe from a partition, and treating a sideboard as solid
fragments every room the horde is supposed to come out of.

Two things make it work. The grid is 1 m, finer than a doorway, and every
doorway is registered by the generator and carved back open after wall
rasterisation — rasterising walls alone reliably seals a 1 m gap, because the
segments either side each block their own cell. And the flood is bounded to
about 130 m of walking distance: a full-map solve costs ~13 ms, which is a
visible hitch several times a second, while anything further away is not
chasing the player yet and falls back to direct steering. Bounded, it costs
~2.5 ms.

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
* The navigation grid was coarser than a doorway, so **every** building interior
  in the town was unreachable: the horde could never come out of a building and
  could never follow the player into one. Nothing visual showed this — the
  buildings looked fine, the infected pathed fine in the street — and it only
  surfaced once `validate.mjs` started flood-filling from the player's start and
  asserting that the room behind each front door could be reached. That test now
  runs on every seed.
* Both horizontal input axes were inverted. The camera basis is right-handed
  with +Z forward and +Y up, which puts screen-right at world −X; the look code
  added the mouse delta to yaw and the strafe code used the negated right
  vector, so mouse-right looked left and D strafed left. They were consistent
  with *each other*, which is exactly why it went unnoticed for so long.

  The first regression test written for this was worthless: it compared yaw
  against the same right-vector formula the movement code uses, so if the
  assumption had been wrong the test would have cheerfully confirmed the bug.
  The check now cross-correlates the actual framebuffer before and after an
  input and asserts the scene slides the correct way — it measures what the
  player sees rather than what the code believes. `tools/diag-axis.mjs` does the
  same thing standalone and prints the direction in words.

  Note for anyone chasing a repeat of this: browsers cache ES modules
  aggressively. `index.html` carries a build stamp that is printed to the
  console and shown on the start screen; if it does not match the newest commit,
  the copy in the browser is stale.
* That fix corrected the *controls* and stopped there. Three other things turn a
  world bearing into a left/right cue, and all three had been written against
  the old, wrong sense of "right", so they kept telling the player their
  horizontal axis was backwards after the axis itself was fixed:
  the compass strip (landmarks and cardinals swept the opposite way to the
  world, and the rose read N-W-S-E as you turned right), the damage direction
  indicators (a hit from your right drew an arrow on your left), and the stereo
  pan in `audio.js`, which projected onto `(cos yaw, -sin yaw)` — the listener's
  *left*. `bearingRight` and `rightOfYaw` in `math.js` now hold that conversion
  in one commented place, and `smoke.mjs` asserts that a landmark rendered on
  the right of the framebuffer is right of the compass centre and pans right.
* `F4` used to mirror both horizontal axes and persist the choice in
  `localStorage`. One stray keypress therefore left look *and* strafe inverted
  in every later session, with a stale saved flag and no indication why — the
  original bug's exact symptoms, reintroduced by the thing meant to work around
  it. A saved horizontal sense is indistinguishable from a broken one, so it is
  no longer saved: `F4` flips it for the session, `?mirrorx=1` makes a flip
  stick, any leftover `localStorage` key is deleted at boot, and the sense in
  force is printed on the start screen and in the `F3` overlay. If the axes are
  ever reported as reversed again, that readout and the build stamp say in one
  glance whether it is the game or the copy in the browser.
* Ground surfaces were subdivided by bisecting the longest edge, which bounds
  edge length but not aspect ratio. The resulting slivers made affine mapping
  smear grass into long streaks. Ground is now grid-clipped per triangle, which
  bounds both, and walkable surfaces use 1.5 m cells because affine error scales
  with the depth ratio across a polygon and that is worst underfoot.
* Traffic was scattered at random positions along each road strip with no
  spacing test, so vehicles routinely spawned inside one another. They are now
  placed into discrete slots and rejected against every vehicle already parked,
  and against every building footprint.
* Interior furniture registered its collision at absolute y=0 rather than at the
  height of the floor it was standing on. On the ground floor that put a bed's
  collision low enough to be stepped over, so you walked through it; on the first
  floor it put a wardrobe in the hallway underneath. Both were invisible, and
  both went away when `solidBox` started lifting its height range by the mesh
  builder's own accumulated translation — which is what the geometry beside it
  had been doing all along.
* `World.openSector` returned early when there were no uploaded chunk meshes,
  before touching collision. Everything about the progression system therefore
  worked in the browser and did nothing at all in the headless tests that were
  supposed to be checking it. The collision sweep now comes first and
  unconditionally: a state change must not be contingent on there being
  something to draw.
