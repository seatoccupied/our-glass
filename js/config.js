/* Our Glass — all tuning constants live here.
   Loaded in the browser as a classic script AND require()'d by test/economy-sim.js. */
(function (root) {
  'use strict';

  var CONFIG = {
    // ---- world scale ----
    R0: 10,              // base sandman radius, world units (constant forever)
    GROWTH: 1.66,        // glass linear growth per era  ✏️ TUNE
    GLASS_W0: 450,       // era-1 glass outer width
    GLASS_H0: 740,       // era-1 glass height
    NECK_HW0: 16,        // era-1 neck half-width (snug: 1.6 guy radii)
    NECK_GROWTH: 1.34,   // neck half-width growth per era  ✏️ TUNE
    NECK_HW_MAX_FRAC: 0.22, // neck never wider than this fraction of bulb halfwidth
    NECK_LEN_FRAC: 0.045,   // neck straight section as a fraction of glass height
    FILL_FRAC: 0.90,     // chamber counts as "full" at this fraction of its area  ✏️ TUNE

    // ---- physics ----
    GRAVITY: 900,        // world units / s^2
    DT: 1 / 60,
    RESTITUTION: 0.18,
    FRICTION: 0.86,      // tangential velocity keep on ground contact
    LIVE_CAP: 260,       // max live physics bodies  ✏️ TUNE
    QUIET_SPEED: 14,     // damping threshold for crowded/grounded guys
    JAM_SECONDS: 5.0,    // stuck in the neck this long -> comedy pop-through
    SLOPE_MAX: 0.75,     // pile angle of repose (height diff per column width)

    // ---- pacing / economy ----  ✏️ TUNE (economy-sim checks these)
    BASE_DROP_INTERVAL: 1.35,  // seconds between drops at level 0
    BASE_SAND: 3,              // sand for a base-size guy landing
    GOLD_MULT: 25,
    VARIETY_BONUS: 0.05,       // +5% income per unlocked color beyond the first 3
    OFFLINE_CAP_HOURS: 3,
    OFFLINE_EFF: 0.6,          // offline income efficiency
    DRAIN_BASE: 1.4,           // guys/sec through an era-1 neck while draining  ✏️ TUNE

    // ---- spectacle ----
    SPAWN_HEIGHT: 90,          // how far above the rim guys appear
    MAX_FLOATERS: 14,          // concurrent "+N" texts
    FLIP_ANIM_SECONDS: 4.2,
    FLIP_AUTO_SECONDS: 10,     // auto-flip if the button sits unpressed
    DOOM_FILL: 0.9             // the Doomsayer appears at this fill fraction
  };

  // Sandman colors, unlocked in order by the Variety upgrade. Index is stored per
  // guy (compact!) so a future match/merge mechanic can bolt on.
  var PALETTE = [
    { name: 'Coral',     hex: '#ff6b6b' },
    { name: 'Amber',     hex: '#ffb84d' },
    { name: 'Sky',       hex: '#4dabff' },
    { name: 'Mint',      hex: '#4dd599' },
    { name: 'Lilac',     hex: '#b78aff' },
    { name: 'Rose',      hex: '#ff7ab8' },
    { name: 'Lemon',     hex: '#ffe066' },
    { name: 'Teal',      hex: '#2ec4b6' },
    { name: 'Tangerine', hex: '#ff9f43' },
    { name: 'Berry',     hex: '#c44dff' }
  ];
  var GOLD_HEX = '#ffd700';
  var START_COLORS = 3;

  // Eras. Each flip unlocks the next entry's toys — the game's teaching rhythm.
  var ERAS = [
    { name: 'The First Grains' },                                   // era 1
    { name: 'The Age of Huts',      unlock: 'builders',
      card: ['NEW: The Builders', 'Your little guys have discovered architecture. Huts earn bonus sand and help fill the glass — until the flip.'] },
    { name: 'The Wide Throat',      unlock: 'neck',
      card: ['NEW: Glasswork', 'The neck can be widened. More flow, fewer jams. The jams were funnier, but progress is progress.'] },
    { name: 'The Age of Pyramids',  unlock: 'stackers',
      card: ['NEW: The Stackers', 'Guys climbing on guys. The human pyramid: pure spectacle, occasionally collapses. Nobody is ever hurt.'] },
    { name: 'The Singing Era',      unlock: 'bards',
      card: ['NEW: The Bards', 'Someone found a tiny lute. Songs boost ALL sand income. The songs are about the sky. They do not know.'] },
    { name: 'The Golden Age',       unlock: 'gold',
      card: ['NEW: Golden Sandmen', 'Rare, shiny, worth 25×. The society considers them royalty. They are just as doomed.'] },
    { name: 'The Long Pour' },                                      // era 7
    { name: 'The Deep Time' },
    { name: 'The Patient Mountain' },
    { name: 'The Endless Noon' }
    // beyond: "The Nth Era"
  ];

  // Upgrade definitions. Effects are read by economy.js getters.
  // cost(level) = base * mult^level ; maxLevel optional ; era = first era visible.
  var UPGRADES = [
    // Foundation four
    { id: 'rate',    icon: '⏱️', name: 'Cloud Seeding',
      desc: 'Sandmen drop more often.',
      base: 15,   mult: 1.55, era: 1, max: 24 },
    { id: 'size',    icon: '🍔', name: 'Bigger Guys',
      desc: 'Chunkier sandmen. Worth more sand, squeeze harder.',
      base: 40,   mult: 1.9,  era: 1, max: 10 },
    { id: 'multi',   icon: '👯', name: 'Group Skydiving',
      desc: '+1 sandman per drop.',
      base: 550,  mult: 3.1,  era: 2, max: 9 },
    { id: 'colors',  icon: '🎨', name: 'New Dye',
      desc: 'Unlocks a new sandman color. Variety cheers everyone up: +5% sand.',
      base: 120,  mult: 2.4,  era: 2, max: 7 },   // 3 start + 7 = full palette
    // Society branch
    { id: 'builders', icon: '🏠', name: 'Blueprints',
      desc: 'Builders work faster and dream bigger (more, bigger structures).',
      base: 300,  mult: 2.1,  era: 2, max: 12, branch: 'society' },
    { id: 'stackers', icon: '🤸', name: 'Pyramid Permits',
      desc: 'Bigger human pyramids, more often.',
      base: 4000, mult: 2.3,  era: 4, max: 8, branch: 'society' },
    { id: 'bards',    icon: '🎸', name: 'Louder Lutes',
      desc: 'Bard songs boost ALL sand income.',
      base: 15000, mult: 2.6, era: 5, max: 10, branch: 'society' },
    // Glasswork branch
    { id: 'neck',    icon: '⏳', name: 'Throat Polish',
      desc: 'A wider neck. Guys flow through faster after a flip.',
      base: 900,  mult: 2.6,  era: 3, max: 8, branch: 'glass' },
    { id: 'gold',    icon: '✨', name: 'Golden Touch',
      desc: 'Better odds of a Golden Sandman (worth 25×).',
      base: 30000, mult: 2.8, era: 6, max: 8, branch: 'glass' },
    { id: 'deep',    icon: '🌌', name: 'Deep Time',
      desc: 'All sand income +20%. The mountain remembers.',
      base: 120000, mult: 3.4, era: 7, max: 99, branch: 'glass' }
  ];

  var OUT = { CONFIG: CONFIG, PALETTE: PALETTE, GOLD_HEX: GOLD_HEX,
              START_COLORS: START_COLORS, ERAS: ERAS, UPGRADES: UPGRADES };

  root.CONFIG = CONFIG;
  root.PALETTE = PALETTE;
  root.GOLD_HEX = GOLD_HEX;
  root.START_COLORS = START_COLORS;
  root.ERAS = ERAS;
  root.UPGRADES = UPGRADES;
  if (typeof module !== 'undefined' && module.exports) module.exports = OUT;
})(typeof window !== 'undefined' ? window : globalThis);
