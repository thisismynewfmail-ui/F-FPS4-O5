// ---------------------------------------------------------------------------
// materials.js — the town's material library.
//
// Registration is lazy: `define()` reserves a texture-array layer and queues a
// closure. The loader runs the queue in slices so the browser can paint a
// progress bar instead of hanging.
//
// The brief bans reusing one wall texture everywhere. This library answers that
// with ~30 distinct wall treatments (different bond patterns, board pitches,
// aggregate, colour) each generated in a clean and a weathered state, plus
// separate texture sets for roofs, trim, foundations, doors, windows, ground
// and interiors. Style kits then combine them so that no two neighbouring
// buildings share a full material set.
// ---------------------------------------------------------------------------

import { RNG, fbm } from '../core/math.js';
import * as T from './texgen.js';

export class MaterialLibrary {
  constructor(seed = 1337) {
    this.rng = new RNG(seed);
    this.tasks = [];
    this.mats = {};
    this.layers = [];
    this.count = 0;
  }

  /** Reserve a layer; the factory runs later during loading. */
  define(name, opts, factory) {
    if (this.mats[name]) return this.mats[name];
    const layer = this.count++;
    const m = { layer, tile: opts.tile ?? 2, name };
    if (opts.fit) m.fit = true;
    if (opts.rot) m.rot = true;
    if (opts.flipV) m.flipV = true;
    this.mats[name] = m;
    const seed = (layer * 2654435761) >>> 0;
    this.tasks.push({
      name,
      run: () => { this.layers[layer] = factory(new RNG(seed)).data; },
    });
    return m;
  }

  /** Fetch a material, optionally overriding the world-space tile size. */
  m(name, tile) {
    const base = this.mats[name];
    if (!base) throw new Error(`Unknown material: ${name}`);
    if (tile === undefined || tile === base.tile) return base;
    return Object.assign({}, base, { tile });
  }

  has(name) { return !!this.mats[name]; }
}

// --- colour vocabulary -----------------------------------------------------

const C = {
  brickRed: [142, 74, 58], brickDeep: [104, 52, 44], brickBrown: [118, 84, 62],
  brickBuff: [176, 152, 118], brickTan: [168, 138, 100], brickPaint: [186, 180, 168],
  brickCity: [126, 72, 62], brickGlaze: [148, 152, 148],
  white: [206, 202, 192], cream: [212, 200, 172], sage: [150, 158, 136],
  paleBlue: [154, 170, 176], butter: [204, 188, 132], dove: [162, 160, 152],
  mint: [156, 176, 158], chestnut: [122, 92, 66], peach: [206, 174, 148],
  clay: [178, 132, 104], stoneGrey: [146, 142, 132], stoneWarm: [156, 146, 124],
  concrete: [150, 148, 142], concreteDark: [116, 116, 112], cmu: [154, 152, 144],
  cmuPaint: [168, 172, 160], steel: [122, 126, 128], rustMetal: [138, 96, 62],
  asphaltRoof: [72, 72, 74], shingleBrown: [92, 76, 58], shingleGreen: [72, 84, 70],
  shingleSlate: [86, 90, 96], clayRoof: [150, 84, 54],
  trimWhite: [214, 210, 200], trimCream: [216, 204, 174], trimSage: [122, 134, 112],
  trimNavy: [66, 78, 98], trimMaroon: [104, 56, 52], trimGrey: [140, 138, 132],
  trimBrown: [104, 82, 60], trimBlack: [58, 56, 54], trimTeal: [82, 116, 116],
  trimOlive: [110, 112, 74], trimRust: [148, 84, 50], trimMustard: [176, 148, 74],
  trimSlate: [96, 104, 114], trimSky: [136, 160, 176],
};

/** Named wall treatments. Each becomes a clean layer and a weathered layer. */
const WALL_DEFS = [
  // --- residential brick
  { id: 'brick_red', tile: 2.4, gen: (r) => T.brick(r, { color: C.brickRed, brickW: 32, brickH: 16 }), decay: { moss: true, peel: false } },
  { id: 'brick_deep', tile: 2.2, gen: (r) => T.brick(r, { color: C.brickDeep, brickW: 32, brickH: 16, variance: 22 }), decay: { moss: true } },
  { id: 'brick_brown', tile: 2.6, gen: (r) => T.brick(r, { color: C.brickBrown, brickW: 42.67, brickH: 16, gap: 3 }), decay: { moss: true } },
  { id: 'brick_buff', tile: 2.4, gen: (r) => T.brick(r, { color: C.brickBuff, brickW: 32, brickH: 21.33, mortar: [186, 180, 166] }), decay: { moss: true } },
  { id: 'brick_painted', tile: 2.4, gen: (r) => T.brick(r, { color: C.brickPaint, brickW: 32, brickH: 16, mortar: [196, 192, 184], variance: 8 }), decay: { peel: true, peelUnder: C.brickRed } },
  { id: 'brick_tall', tile: 2.0, gen: (r) => T.brick(r, { color: C.brickTan, brickW: 21.33, brickH: 32, jitterRow: true }), decay: { moss: true } },

  // --- residential siding
  { id: 'siding_white', tile: 2.2, gen: (r) => T.siding(r, { color: C.white, boardH: 16 }), decay: { peel: true, peelUnder: [128, 118, 100] } },
  { id: 'siding_cream', tile: 2.4, gen: (r) => T.siding(r, { color: C.cream, boardH: 21.33 }), decay: { peel: true, peelUnder: [120, 104, 84] } },
  { id: 'siding_sage', tile: 2.2, gen: (r) => T.siding(r, { color: C.sage, boardH: 16 }), decay: { peel: true, moss: true, peelUnder: [96, 100, 86] } },
  { id: 'siding_blue', tile: 2.6, gen: (r) => T.siding(r, { color: C.paleBlue, boardH: 12.8 }), decay: { peel: true, peelUnder: [96, 106, 110] } },
  { id: 'siding_butter', tile: 2.2, gen: (r) => T.siding(r, { color: C.butter, boardH: 16 }), decay: { peel: true, peelUnder: [128, 116, 78] } },
  { id: 'siding_dove', tile: 2.4, gen: (r) => T.siding(r, { color: C.dove, boardH: 21.33 }), decay: { peel: true, peelUnder: [98, 96, 90] } },
  { id: 'siding_mint', tile: 2.2, gen: (r) => T.siding(r, { color: C.mint, boardH: 16 }), decay: { peel: true, moss: true, peelUnder: [100, 112, 100] } },
  { id: 'shake_brown', tile: 1.8, gen: (r) => T.shingle(r, { color: C.chestnut, rowH: 21.33, tabW: 32 }), decay: { moss: true } },

  // --- render / stucco
  { id: 'stucco_cream', tile: 2.8, gen: (r) => T.stucco(r, { color: [206, 194, 168] }), decay: { crack: true, peel: true, peelUnder: [150, 138, 116] } },
  { id: 'stucco_peach', tile: 2.8, gen: (r) => T.stucco(r, { color: C.peach }), decay: { crack: true, peel: true, peelUnder: [148, 120, 100] } },
  { id: 'stucco_grey', tile: 3.0, gen: (r) => T.stucco(r, { color: [162, 158, 150] }), decay: { crack: true, moss: true } },
  { id: 'stucco_clay', tile: 2.6, gen: (r) => T.stucco(r, { color: C.clay }), decay: { crack: true, peel: true, peelUnder: [136, 100, 76] } },

  // --- commercial / civic
  { id: 'brick_city', tile: 2.2, gen: (r) => T.brick(r, { color: C.brickCity, brickW: 32, brickH: 12.8, mortar: [126, 122, 114] }), decay: { moss: true } },
  { id: 'brick_glaze', tile: 2.0, gen: (r) => T.brick(r, { color: C.brickGlaze, brickW: 21.33, brickH: 21.33, mortar: [176, 178, 174], variance: 8 }), decay: { crack: true } },
  { id: 'stone_ashlar', tile: 3.2, gen: (r) => T.stone(r, { color: C.stoneGrey, courseH: 32 }), decay: { moss: true, stains: true } },
  { id: 'stone_warm', tile: 3.6, gen: (r) => T.stone(r, { color: C.stoneWarm, courseH: 42.67, minW: 32, maxW: 64 }), decay: { moss: true } },
  { id: 'concrete_precast', tile: 3.2, gen: (r) => T.concrete(r, { color: C.concrete, formH: 64 }), decay: { crack: true, stains: true } },
  { id: 'concrete_brutal', tile: 3.0, gen: (r) => T.concrete(r, { color: C.concreteDark, formH: 32, cracks: 2 }), decay: { crack: true, stains: true, moss: true } },

  // --- industrial
  { id: 'cmu_grey', tile: 3.2, gen: (r) => T.concrete(r, { color: C.cmu, blocks: true, formLines: false }), decay: { crack: true, moss: true, stains: true } },
  { id: 'cmu_painted', tile: 3.2, gen: (r) => T.concrete(r, { color: C.cmuPaint, blocks: true, formLines: false }), decay: { peel: true, peelUnder: C.cmu, stains: true } },
  { id: 'metal_ribbed', tile: 2.4, gen: (r) => T.corrugated(r, { color: C.steel, pitch: 8 }), decay: { rust: true, moss: false, crack: false } },
  { id: 'metal_rust', tile: 2.4, gen: (r) => T.corrugated(r, { color: C.rustMetal, pitch: 10.67 }), decay: { rust: true, crack: false } },
  { id: 'board_barn', tile: 2.2, gen: (r) => T.boards(r, { color: [110, 84, 60], boardW: 16, batten: true }), decay: { moss: true, peel: true, peelUnder: [78, 62, 46] } },
  { id: 'concrete_ind', tile: 3.4, gen: (r) => T.concrete(r, { color: [128, 126, 120], formH: 42.67, cracks: 3 }), decay: { crack: true, rust: true, stains: true, moss: true } },
];

const ROOF_DEFS = [
  { id: 'roof_asphalt', tile: 1.6, gen: (r) => T.shingle(r, { color: C.asphaltRoof }) },
  { id: 'roof_brown', tile: 1.6, gen: (r) => T.shingle(r, { color: C.shingleBrown, rowH: 21.33 }) },
  { id: 'roof_green', tile: 1.6, gen: (r) => T.shingle(r, { color: C.shingleGreen }) },
  { id: 'roof_slate', tile: 1.4, gen: (r) => T.shingle(r, { color: C.shingleSlate, rowH: 12.8, tabW: 16 }) },
  { id: 'roof_worn', tile: 1.6, gen: (r) => T.shingle(r, { color: [88, 82, 76], missing: 5 }) },
  { id: 'roof_clay', tile: 1.4, gen: (r) => T.clayTile(r, { color: C.clayRoof }) },
  { id: 'roof_metal', tile: 2.0, gen: (r) => T.corrugated(r, { color: [138, 140, 138], pitch: 10.67 }) },
  { id: 'roof_flat', tile: 3.0, gen: (r) => T.builtUpRoof(r, {}) },
  { id: 'roof_tar', tile: 2.6, gen: (r) => T.builtUpRoof(r, { color: [54, 52, 50] }) },
];

const TRIM_COLORS = [
  ['trim_white', C.trimWhite], ['trim_cream', C.trimCream], ['trim_sage', C.trimSage],
  ['trim_navy', C.trimNavy], ['trim_maroon', C.trimMaroon], ['trim_grey', C.trimGrey],
  ['trim_brown', C.trimBrown], ['trim_black', C.trimBlack],
  ['trim_rust', C.trimRust], ['trim_slate', C.trimSlate],
];

const FOUNDATION_DEFS = [
  { id: 'found_poured', tile: 2.0, gen: (r) => T.concrete(r, { color: [128, 126, 120], formH: 32 }) },
  { id: 'found_brick', tile: 1.6, gen: (r) => T.brick(r, { color: [110, 76, 62], brickW: 21.33, brickH: 10.67, mortar: [128, 124, 116] }) },
  { id: 'found_stone', tile: 2.2, gen: (r) => T.stone(r, { color: [120, 116, 108], courseH: 21.33, minW: 18, maxW: 40 }) },
  { id: 'found_slab', tile: 2.4, gen: (r) => T.concrete(r, { color: [144, 142, 136], formLines: false }) },
  { id: 'found_dark', tile: 2.0, gen: (r) => T.concrete(r, { color: [98, 96, 92], formH: 21.33, cracks: 3 }) },
];

/**
 * Registers everything. Returns the library plus the style-kit table used by
 * the building generator.
 */
export function buildLibrary(seed = 1337) {
  const lib = new MaterialLibrary(seed);
  const D = (n, o, f) => lib.define(n, o, f);

  // --- walls: clean + weathered ------------------------------------------
  lib.wallIds = [];
  for (const w of WALL_DEFS) {
    lib.wallIds.push(w.id);
    D(`${w.id}`, { tile: w.tile }, (r) => T.weather(w.gen(r), 0.10, r, Object.assign({ crack: false }, w.decay)));
    D(`${w.id}#w`, { tile: w.tile }, (r) => T.weather(w.gen(r), 0.85, r, w.decay || {}));
  }

  // --- roofs --------------------------------------------------------------
  lib.roofIds = ROOF_DEFS.map((x) => x.id);
  for (const rf of ROOF_DEFS) {
    D(rf.id, { tile: rf.tile }, (r) => T.weather(rf.gen(r), 0.12, r, { moss: false, crack: false }));
    D(`${rf.id}#w`, { tile: rf.tile }, (r) => T.weather(rf.gen(r), 0.8, r, { moss: true, stains: true, crack: false }));
  }

  // --- trim ---------------------------------------------------------------
  lib.trimIds = TRIM_COLORS.map((t) => t[0]);
  for (const [id, col] of TRIM_COLORS) {
    D(id, { tile: 1.2 }, (r) => T.weather(T.paint(r, { color: col, wood: true }), 0.08, r, { crack: false, moss: false }));
    D(`${id}#w`, { tile: 1.2 }, (r) => T.weather(T.paint(r, { color: col, wood: true }), 0.8, r,
      { peel: true, peelUnder: [118, 104, 84], moss: true, crack: false }));
  }

  // --- foundations --------------------------------------------------------
  lib.foundIds = FOUNDATION_DEFS.map((x) => x.id);
  for (const f of FOUNDATION_DEFS) {
    D(f.id, { tile: f.tile }, (r) => T.weather(f.gen(r), 0.3, r, { moss: true, stains: true }));
    D(`${f.id}#w`, { tile: f.tile }, (r) => T.weather(f.gen(r), 0.9, r, { moss: true, stains: true, crack: true }));
  }

  // --- doors (fitted) -----------------------------------------------------
  const doorDefs = [
    ['door_wood_white', { color: [188, 182, 168], style: 'panel' }],
    ['door_wood_red', { color: [128, 62, 52], style: 'panel' }],
    ['door_wood_blue', { color: [72, 88, 108], style: 'panel' }],
    ['door_wood_brown', { color: [104, 74, 48], style: 'panel' }],
    ['door_glass', { color: [122, 118, 110], style: 'glass' }],
    ['door_glass_broken', { color: [122, 118, 110], style: 'glass', broken: true }],
    ['door_metal', { color: [108, 112, 114], style: 'metal' }],
    ['door_metal_rust', { color: [128, 96, 68], style: 'metal' }],
    ['door_garage', { color: [154, 150, 142], style: 'garage' }],
  ];
  lib.doorIds = doorDefs.map((d) => d[0]);
  for (const [id, p] of doorDefs) {
    D(id, { tile: 1, fit: true }, (r) => T.weather(T.door(r, p), 0.25, r, { moss: false, crack: false, stains: true }));
    D(`${id}#w`, { tile: 1, fit: true }, (r) => T.weather(T.door(r, p), 0.85, r,
      { peel: true, moss: true, stains: true, rust: p.style === 'metal' || p.style === 'garage' }));
  }

  // --- windows (fitted) ---------------------------------------------------
  const winDefs = [
    ['win_house', { cols: 2, rows: 2, frame: [200, 196, 184] }],
    ['win_house_curtain', { cols: 2, rows: 2, frame: [200, 196, 184], curtain: true }],
    ['win_house_dark', { cols: 2, rows: 3, frame: [176, 172, 160], glass: [30, 34, 40] }],
    ['win_bath', { cols: 1, rows: 1, frame: [198, 194, 182], glass: [96, 108, 108], gloss: 0.8 }],
    ['win_shop', { cols: 3, rows: 1, frame: [128, 126, 120], gloss: 0.75, litRoom: true }],
    ['win_office', { cols: 2, rows: 2, frame: [110, 112, 112], glass: [40, 50, 58] }],
    ['win_industrial', { cols: 4, rows: 4, frame: [116, 114, 108], glass: [58, 66, 68] }],
    ['win_broken', { cols: 2, rows: 2, frame: [180, 176, 164], broken: true }],
    ['win_broken_shop', { cols: 3, rows: 1, frame: [124, 122, 116], broken: true }],
    ['win_boarded', { cols: 2, rows: 2, frame: [170, 166, 154], boarded: true }],
    ['win_boarded_shop', { cols: 3, rows: 1, frame: [124, 122, 116], boarded: true }],
    ['win_church', { cols: 1, rows: 3, frame: [128, 120, 104], glass: [58, 46, 78], gloss: 0.7 }],
  ];
  lib.winIds = winDefs.map((d) => d[0]);
  for (const [id, p] of winDefs) {
    D(id, { tile: 1, fit: true }, (r) => T.weather(T.windowTex(r, p), 0.2, r, { moss: false, crack: false }));
    D(`${id}#w`, { tile: 1, fit: true }, (r) => T.weather(T.windowTex(r, p), 0.8, r, { moss: true, stains: true, crack: false }));
  }

  // --- ground & roads -----------------------------------------------------
  D('road_asphalt', { tile: 5 }, (r) => T.asphalt(r, {}));
  D('road_worn', { tile: 5 }, (r) => T.weather(T.asphalt(r, { color: [72, 70, 68] }), 0.7, r, { moss: true, crack: true }));
  D('road_concrete', { tile: 6 }, (r) => T.concrete(r, { color: [124, 122, 118], formLines: false, cracks: 4 }));
  D('sidewalk', { tile: 4 }, (r) => T.weather(T.sidewalk(r, {}), 0.3, r, { moss: true, crack: true }));
  D('sidewalk_worn', { tile: 4 }, (r) => T.weather(T.sidewalk(r, { color: [140, 136, 128] }), 0.8, r, { moss: true, crack: true }));
  D('curb', { tile: 2 }, (r) => T.weather(T.concrete(r, { color: [162, 158, 150], formLines: false }), 0.4, r, { moss: true, stains: true }));
  D('dirt', { tile: 5 }, (r) => T.ground(r, { color: [78, 70, 54] }));
  D('mud', { tile: 4 }, (r) => T.ground(r, { color: [64, 56, 44] }));
  D('gravel', { tile: 3 }, (r) => T.ground(r, { color: [104, 100, 92], gravel: true }));
  D('grass', { tile: 4 }, (r) => T.ground(r, { color: [66, 70, 46], grass: true, grassColor: [80, 92, 52] }));
  D('grass_dead', { tile: 4 }, (r) => T.ground(r, { color: [82, 74, 50], grass: true, grassColor: [104, 96, 58] }));
  D('plaza_stone', { tile: 3 }, (r) => T.weather(T.floorTile(r, { color: [148, 144, 134], color2: [130, 126, 118], cell: 32 }), 0.5, r, { moss: true, crack: true }));
  D('ballast', { tile: 3 }, (r) => T.ground(r, { color: [92, 88, 82], gravel: true }));
  D('water', { tile: 8 }, (r) => T.solid(r, { color: [42, 54, 56], mottle: 40, grain: 6 }));
  // Exposed rock. `rock` clads the ridge scarp and the cuttings; `rock_dark`
  // is the wet shale in the Hollow and under the river bank.
  D('rock', { tile: 4.5 }, (r) => T.rock(r, { color: [124, 120, 110], lichen: [96, 108, 74] }));
  D('rock_dark', { tile: 4.0 }, (r) => T.rock(r, { color: [86, 86, 84], bandH: 9, joints: 22, scree: true }));

  // --- markings (alpha) ---------------------------------------------------
  D('mark_dash', { tile: 1, fit: true }, (r) => T.markingTex(r, { style: 'dash' }));
  D('mark_solid', { tile: 1, fit: true }, (r) => T.markingTex(r, { style: 'solid' }));
  D('mark_crosswalk', { tile: 1, fit: true }, (r) => T.markingTex(r, { style: 'crosswalk' }));
  D('mark_stop', { tile: 1, fit: true }, (r) => T.markingTex(r, { style: 'stop', color: [206, 200, 160] }));

  // --- interiors ----------------------------------------------------------
  D('floor_wood', { tile: 2.4 }, (r) => T.weather(T.floorWood(r, {}), 0.35, r, { moss: false, crack: false, stains: true }));
  D('floor_wood_dark', { tile: 2.4 }, (r) => T.weather(T.floorWood(r, { color: [86, 62, 40] }), 0.45, r, { moss: false, crack: false, stains: true }));
  D('floor_lino', { tile: 2.0 }, (r) => T.weather(T.floorTile(r, { color: [178, 172, 158], color2: [128, 124, 116], cell: 32 }), 0.4, r, { moss: false, stains: true }));
  D('floor_lino_check', { tile: 2.0 }, (r) => T.weather(T.floorTile(r, { color: [196, 192, 182], color2: [58, 56, 54], cell: 32 }), 0.4, r, { moss: false, stains: true }));
  D('floor_tile_small', { tile: 1.6 }, (r) => T.weather(T.floorTile(r, { color: [186, 186, 178], color2: [162, 162, 154], cell: 16 }), 0.4, r, { moss: false, stains: true }));
  D('floor_carpet_red', { tile: 2.4 }, (r) => T.weather(T.carpet(r, { color: [92, 58, 52] }), 0.5, r, { moss: false, crack: false, stains: true }));
  D('floor_carpet_green', { tile: 2.4 }, (r) => T.weather(T.carpet(r, { color: [66, 74, 58] }), 0.5, r, { moss: false, crack: false, stains: true }));
  D('floor_concrete', { tile: 3.0 }, (r) => T.weather(T.concrete(r, { color: [122, 120, 116], formLines: false, cracks: 3 }), 0.55, r, { stains: true, crack: true }));

  D('wall_paper_floral', { tile: 2.2 }, (r) => T.weather(T.wallpaper(r, { color: [178, 162, 132], motif: true }), 0.4, r, { peel: true, peelUnder: [138, 128, 112], moss: false, crack: false }));
  D('wall_paper_stripe', { tile: 2.2 }, (r) => T.weather(T.wallpaper(r, { color: [166, 158, 146], stripes: 16 }), 0.4, r, { peel: true, peelUnder: [130, 124, 114], moss: false, crack: false }));
  D('wall_paper_blue', { tile: 2.2 }, (r) => T.weather(T.wallpaper(r, { color: [140, 152, 160], motif: true }), 0.45, r, { peel: true, peelUnder: [110, 116, 120], moss: false, crack: false }));
  D('wall_plaster', { tile: 2.6 }, (r) => T.weather(T.wallpaper(r, { color: [188, 182, 168] }), 0.5, r, { peel: true, peelUnder: [140, 132, 118], crack: true, moss: false }));
  D('wall_panel_wood', { tile: 2.0 }, (r) => T.weather(T.boards(r, { color: [116, 88, 58], boardW: 21.33 }), 0.35, r, { moss: false, crack: false, stains: true }));
  D('wall_tile_kitchen', { tile: 1.6 }, (r) => T.weather(T.floorTile(r, { color: [198, 196, 186], color2: [186, 184, 174], cell: 16 }), 0.35, r, { moss: false, stains: true }));
  D('wall_shop', { tile: 2.6 }, (r) => T.weather(T.wallpaper(r, { color: [196, 192, 180] }), 0.4, r, { peel: true, peelUnder: [150, 146, 136], moss: false }));
  D('wall_ind', { tile: 3.0 }, (r) => T.weather(T.concrete(r, { color: [140, 138, 132], blocks: true, formLines: false }), 0.6, r, { rust: true, stains: true, moss: true }));
  D('ceiling_tile', { tile: 2.4 }, (r) => T.weather(T.ceilingTile(r, {}), 0.4, r, { moss: false, crack: false, stains: true }));
  D('ceiling_plaster', { tile: 3.0 }, (r) => T.weather(T.wallpaper(r, { color: [176, 172, 162] }), 0.45, r, { peel: true, peelUnder: [132, 128, 120], crack: true, moss: false }));
  D('ceiling_ind', { tile: 3.0 }, (r) => T.weather(T.corrugated(r, { color: [102, 102, 100] }), 0.6, r, { rust: true, moss: false }));

  // --- glass, mesh, foliage -----------------------------------------------
  D('glass_clear', { tile: 2.0 }, (r) => T.glass(r, { gloss: 0.55 }));
  D('glass_dirty', { tile: 2.0 }, (r) => T.glass(r, { gloss: 0.35, dirty: true }));
  D('glass_broken', { tile: 2.0 }, (r) => T.glass(r, { gloss: 0.4, broken: true, dirty: true }));
  D('chainlink', { tile: 2.0 }, (r) => T.chainlink(r, {}));
  D('chainlink_rust', { tile: 2.0 }, (r) => T.chainlink(r, { rust: true }));
  D('foliage_hedge', { tile: 1, fit: true }, (r) => T.foliage(r, { color: [52, 68, 40], leaves: 200, blades: 60 }));
  D('foliage_weed', { tile: 1, fit: true }, (r) => T.foliage(r, { color: [86, 92, 52], blades: 70 }));
  D('foliage_dead', { tile: 1, fit: true }, (r) => T.foliage(r, { color: [104, 92, 58], blades: 50 }));
  D('foliage_ivy', { tile: 1, fit: true }, (r) => T.foliage(r, { color: [46, 64, 38], leaves: 320, blades: 30 }));
  // Long grass for the verges and the allotments, and the ridge conifers.
  D('foliage_grass', { tile: 1, fit: true }, (r) => T.foliage(r, { color: [74, 86, 46], blades: 130 }));
  D('foliage_pine', { tile: 1, fit: true }, (r) => T.foliage(r, { color: [38, 56, 44], leaves: 260, blades: 90 }));
  D('hoarding', { tile: 2.4 }, (r) => T.weather(T.hoarding(r, {}), 0.6, r, { moss: true, stains: true, peel: true, peelUnder: [120, 108, 84] }));

  // --- props: painted metal, wood, plastic --------------------------------
  const propColors = [
    ['prop_steel', [124, 128, 130]], ['prop_darksteel', [84, 88, 92]],
    ['prop_rust', [126, 82, 50]], ['prop_green', [66, 88, 66]],
    ['prop_red', [136, 58, 50]], ['prop_yellow', [186, 158, 62]],
    ['prop_blue', [64, 84, 116]], ['prop_white', [196, 194, 186]],
    ['prop_black', [48, 48, 50]], ['prop_orange', [180, 106, 46]],
  ];
  for (const [id, col] of propColors) {
    D(id, { tile: 1.4 }, (r) => T.weather(T.paintedMetal(r, { color: col, panelLines: true }), 0.45, r, { rust: true, moss: false, crack: false }));
  }
  D('prop_wood', { tile: 1.2 }, (r) => T.weather(T.boards(r, { color: [128, 98, 64], boardW: 21.33, knots: 4 }), 0.4, r, { moss: false, crack: false, stains: true }));
  D('prop_wood_dark', { tile: 1.2 }, (r) => T.weather(T.boards(r, { color: [88, 66, 44], boardW: 32, knots: 3 }), 0.4, r, { moss: false, crack: false, stains: true }));
  D('prop_wood_pale', { tile: 1.2 }, (r) => T.weather(T.boards(r, { color: [166, 140, 100], boardW: 16, knots: 5 }), 0.35, r, { moss: false, crack: false }));
  D('prop_crate', { tile: 0.9 }, (r) => T.weather(T.boards(r, { color: [148, 116, 74], boardW: 21.33, batten: true }), 0.45, r, { moss: false, crack: false, stains: true }));
  D('prop_fabric_red', { tile: 1.6 }, (r) => T.carpet(r, { color: [112, 58, 52 ] }));
  D('prop_fabric_blue', { tile: 1.6 }, (r) => T.carpet(r, { color: [66, 76, 100] }));
  D('prop_fabric_brown', { tile: 1.6 }, (r) => T.carpet(r, { color: [104, 84, 62] }));
  D('prop_fabric_green', { tile: 1.6 }, (r) => T.carpet(r, { color: [72, 88, 66] }));
  D('prop_paper', { tile: 1.0 }, (r) => T.solid(r, { color: [186, 180, 160], mottle: 26, grain: 10 }));
  D('prop_screen', { tile: 1, fit: true }, (r) => T.solid(r, { color: [36, 40, 44], mottle: 20, grain: 20 }));
  D('prop_porcelain', { tile: 1.4 }, (r) => T.weather(T.solid(r, { color: [204, 202, 194], mottle: 10 }), 0.4, r, { moss: false, crack: true, stains: true }));
  D('prop_chrome', { tile: 1.2 }, (r) => T.paintedMetal(r, { color: [168, 172, 176] }));
  D('prop_dirtmetal', { tile: 1.6 }, (r) => T.weather(T.paintedMetal(r, { color: [104, 100, 94], panelLines: true }), 0.8, r, { rust: true, stains: true }));

  // --- signage ------------------------------------------------------------
  D('sign_shop', { tile: 1, fit: true }, (r) => T.weather(T.signTex(r, { bg: [176, 158, 120], ink: [46, 40, 36], lines: 2, border: true }), 0.4, r, { moss: false }));
  D('sign_shop2', { tile: 1, fit: true }, (r) => T.weather(T.signTex(r, { bg: [92, 106, 116], ink: [212, 208, 196], lines: 2, border: true }), 0.4, r, { moss: false }));
  D('sign_notice', { tile: 1, fit: true }, (r) => T.weather(T.signTex(r, { bg: [204, 198, 180], ink: [44, 40, 38], lines: 4 }), 0.5, r, { moss: false, stains: true }));
  D('sign_hazard', { tile: 1, fit: true }, (r) => T.weather(T.signTex(r, { bg: [188, 156, 44], symbol: 'hazard', lines: 0 }), 0.5, r, { rust: true, moss: false }));
  D('sign_medical', { tile: 1, fit: true }, (r) => T.weather(T.signTex(r, { bg: [216, 212, 202], symbol: 'cross', lines: 0, border: true }), 0.3, r, { moss: false }));
  D('sign_road', { tile: 1, fit: true }, (r) => T.weather(T.signTex(r, { bg: [88, 100, 88], ink: [214, 212, 202], lines: 1 }), 0.55, r, { rust: true, moss: false }));
  D('sign_stopsign', { tile: 1, fit: true }, (r) => T.weather(T.signTex(r, { bg: [148, 44, 38], ink: [220, 216, 208], lines: 1, border: true }), 0.5, r, { rust: true, moss: false }));
  D('sign_poster', { tile: 1, fit: true }, (r) => T.weather(T.signTex(r, { bg: [186, 176, 152], ink: [70, 52, 48], lines: 3 }), 0.7, r, { peel: true, peelUnder: [120, 112, 100], moss: false }));
  // The notice bolted to every cordon gate. Orange on black reads at 320x240
  // from across a junction, which is the whole job: you should be able to see
  // that a road is closed before you have walked down it.
  D('sign_cordon', { tile: 1, fit: true }, (r) => T.weather(T.signTex(r, { bg: [190, 108, 34], ink: [30, 26, 24], lines: 3, border: true }), 0.6, r, { rust: true, moss: false, stains: true }));

  // --- gore / decals ------------------------------------------------------
  D('blood_pool', { tile: 1, fit: true }, (r) => T.bloodTex(r, { radius: 34 }));
  D('blood_splat', { tile: 1, fit: true }, (r) => T.bloodTex(r, { radius: 20, color: [112, 20, 16] }));
  D('blood_old', { tile: 1, fit: true }, (r) => T.bloodTex(r, { radius: 28, color: [62, 24, 22] }));

  // --- the infected -------------------------------------------------------
  D('flesh_pale', { tile: 1.0 }, (r) => T.fleshTex(r, { color: [148, 138, 124], tint: [96, 104, 88] }));
  D('flesh_grey', { tile: 1.0 }, (r) => T.fleshTex(r, { color: [122, 120, 112], tint: [74, 84, 76], wounds: 20 }));
  D('flesh_bloat', { tile: 1.0 }, (r) => T.fleshTex(r, { color: [128, 134, 112], tint: [70, 92, 66], wounds: 26 }));
  D('cloth_worker', { tile: 1.0 }, (r) => T.weather(T.solid(r, { color: [72, 84, 104] }), 0.6, r, { moss: false, crack: false, stains: true }));
  D('cloth_hazmat', { tile: 1.0 }, (r) => T.weather(T.solid(r, { color: [164, 156, 96] }), 0.6, r, { moss: false, crack: false, stains: true }));
  D('cloth_civ', { tile: 1.0 }, (r) => T.weather(T.solid(r, { color: [118, 96, 88] }), 0.6, r, { moss: false, crack: false, stains: true }));
  D('cloth_medic', { tile: 1.0 }, (r) => T.weather(T.solid(r, { color: [178, 176, 168] }), 0.7, r, { moss: false, crack: false, stains: true }));
  D('cloth_cop', { tile: 1.0 }, (r) => T.weather(T.solid(r, { color: [52, 56, 72] }), 0.5, r, { moss: false, crack: false, stains: true }));
  D('cloth_dark', { tile: 1.0 }, (r) => T.weather(T.solid(r, { color: [58, 54, 52] }), 0.6, r, { moss: false, crack: false, stains: true }));

  // --- weapons / viewmodel ------------------------------------------------
  D('gun_metal', { tile: 0.6 }, (r) => T.paintedMetal(r, { color: [72, 74, 78] }));
  D('gun_dark', { tile: 0.6 }, (r) => T.paintedMetal(r, { color: [44, 44, 48] }));
  D('gun_wood', { tile: 0.6 }, (r) => T.boards(r, { color: [104, 72, 44], boardW: 64, knots: 1 }));
  D('gun_grip', { tile: 0.5 }, (r) => T.solid(r, { color: [38, 38, 40], mottle: 30, grain: 22 }));
  D('muzzle_flash', { tile: 1, fit: true }, (r) => {
    const t = new T.Tex();
    t.fill([0, 0, 0], 0);
    for (let i = 0; i < 90; i++) {
      const a = r.next() * Math.PI * 2, d = r.range(0, 46);
      t.blob(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, r.range(4, 16),
        d < 20 ? [255, 250, 220] : [242, 186, 96], r, 1);
    }
    for (let i = 0; i < t.data.length; i += 4) {
      const lum = t.data[i] + t.data[i + 1] + t.data[i + 2];
      t.data[i + 3] = lum > 30 ? 255 : 0;
    }
    return t;
  });

  // --- sky-adjacent / misc ------------------------------------------------
  D('white', { tile: 1 }, () => { const t = new T.Tex(); t.fill([230, 230, 230]); return t; });
  D('black', { tile: 1 }, () => { const t = new T.Tex(); t.fill([16, 16, 18]); return t; });
  D('light_panel', { tile: 1 }, (r) => T.solid(r, { color: [220, 214, 190], mottle: 8, grain: 4 }));
  D('fire', { tile: 1, fit: true }, (r) => {
    const t = new T.Tex();
    t.fill([0, 0, 0], 0);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        const dx = (x - 64) / 40, dy = (y - 128) / 110;
        const n = fbm(x * 0.05, y * 0.05, 3, 91, 0) - 0.5;
        const shape = 1 - Math.hypot(dx * (1.4 - dy * 0.7), dy * 1.1);
        if (shape + n * 0.4 > 0.55) {
          const heat = Math.max(0, Math.min(1, shape + n * 0.3));
          t.set(x, y, heat > 0.7 ? [255, 244, 190] : heat > 0.5 ? [244, 176, 70] : [198, 92, 38], 255);
        }
      }
    }
    return t;
  });

  return lib;
}

/**
 * Style kits pair a wall treatment with trim, roof, foundation, door and window
 * choices. Buildings pick a kit by district and then vary within it, so
 * neighbours never share a complete material set.
 */
export function buildKits(lib, rng) {
  const kit = (o) => o;
  const residentialWalls = [
    'siding_white', 'siding_cream', 'siding_sage', 'siding_blue', 'siding_butter',
    'siding_dove', 'siding_mint', 'shake_brown', 'brick_red', 'brick_deep',
    'brick_brown', 'brick_buff', 'brick_painted', 'brick_tall',
    'stucco_cream', 'stucco_peach', 'stucco_grey', 'stucco_clay',
  ];
  const commercialWalls = [
    'brick_city', 'brick_glaze', 'brick_red', 'brick_buff', 'concrete_precast',
    'stucco_grey', 'stone_ashlar', 'brick_deep', 'concrete_brutal', 'stucco_clay',
  ];
  const civicWalls = ['stone_ashlar', 'stone_warm', 'brick_city', 'concrete_brutal', 'brick_buff'];
  const industrialWalls = ['cmu_grey', 'cmu_painted', 'metal_ribbed', 'metal_rust', 'board_barn', 'concrete_ind'];

  const pitchedRoofs = ['roof_asphalt', 'roof_brown', 'roof_green', 'roof_slate', 'roof_worn', 'roof_clay', 'roof_metal'];
  const flatRoofs = ['roof_flat', 'roof_tar'];

  const mk = (walls, roofs, opts) => {
    const kits = [];
    for (let i = 0; i < walls.length; i++) {
      kits.push(kit(Object.assign({
        id: `${opts.prefix}_${i}`,
        wall: walls[i],
        trim: lib.trimIds[rng.int(0, lib.trimIds.length - 1)],
        trimAlt: lib.trimIds[rng.int(0, lib.trimIds.length - 1)],
        roof: roofs[rng.int(0, roofs.length - 1)],
        foundation: opts.foundations[rng.int(0, opts.foundations.length - 1)],
        door: opts.doors[rng.int(0, opts.doors.length - 1)],
        window: opts.windows[rng.int(0, opts.windows.length - 1)],
      }, opts.extra || {})));
    }
    return kits;
  };

  return {
    residential: mk(residentialWalls, pitchedRoofs, {
      prefix: 'res',
      foundations: ['found_poured', 'found_brick', 'found_stone'],
      doors: ['door_wood_white', 'door_wood_red', 'door_wood_blue', 'door_wood_brown'],
      windows: ['win_house', 'win_house_curtain', 'win_house_dark'],
    }),
    commercial: mk(commercialWalls, flatRoofs.concat(['roof_metal']), {
      prefix: 'com',
      foundations: ['found_poured', 'found_slab', 'found_dark'],
      doors: ['door_glass', 'door_glass_broken', 'door_metal', 'door_wood_brown'],
      windows: ['win_shop', 'win_office'],
    }),
    civic: mk(civicWalls, ['roof_slate', 'roof_clay', 'roof_tar', 'roof_metal'], {
      prefix: 'civ',
      foundations: ['found_stone', 'found_poured'],
      doors: ['door_wood_brown', 'door_metal', 'door_glass'],
      windows: ['win_office', 'win_church', 'win_house_dark'],
    }),
    industrial: mk(industrialWalls, flatRoofs.concat(['roof_metal']), {
      prefix: 'ind',
      foundations: ['found_slab', 'found_dark'],
      doors: ['door_metal', 'door_metal_rust', 'door_garage'],
      windows: ['win_industrial', 'win_broken'],
    }),
  };
}
