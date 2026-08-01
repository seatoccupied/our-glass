/* Sand, upgrades, and every derived rate. Global: Econ
   Rule from the spec: an upgrade that doesn't visibly change the spectacle
   is the wrong upgrade — every effect here maps to something on screen. */
(function () {
  'use strict';

  var Econ = {
    era: 1,
    sand: 0,
    totalEarned: 0,
    levels: {},                    // upgrade id -> level
    counts: { spawned: 0, gold: 0, flips: 0 }
  };

  function lvl(id) { return Econ.levels[id] || 0; }

  function def(id) {
    for (var i = 0; i < UPGRADES.length; i++) if (UPGRADES[i].id === id) return UPGRADES[i];
    return null;
  }

  function costOf(id) {
    var d = def(id);
    return Math.ceil(d.base * Math.pow(d.mult, lvl(id)));
  }
  function isMaxed(id) {
    var d = def(id);
    return d.max != null && lvl(id) >= d.max;
  }
  function canBuy(id) {
    var d = def(id);
    return d && Econ.era >= d.era && !isMaxed(id) && Econ.sand >= costOf(id);
  }
  function buy(id) {
    if (!canBuy(id)) return false;
    Econ.sand -= costOf(id);
    Econ.levels[id] = lvl(id) + 1;
    if (window.Sound) Sound.buy();
    if (id === 'colors') {
      var c = PALETTE[colorCount() - 1];
      if (c && window.UI) UI.toast('New color: ' + c.name,
        'The picker has a new favorite. Variety cheers everyone up (+5% sand).');
    }
    if (id === 'neck' && window.Main) Main.rebuildGlass();
    return true;
  }

  // ---------- derived rates (all ✏️ TUNE-able via config) ----------

  // Each of these six takes an OPTIONAL level, defaulting to the upgrade's
  // current level (Econ.lvl(id)) — no-arg call sites elsewhere are unchanged.
  // The parameter exists so js/ui.js can preview "at next level" for card
  // tooltips without ever mutating Econ.levels (ROADMAP #4).
  function dropInterval(l) {
    l = l == null ? lvl('rate') : l;
    return Math.max(0.07, CONFIG.BASE_DROP_INTERVAL * Math.pow(0.88, l));
  }
  function sizeMult(l) { l = l == null ? lvl('size') : l; return Math.pow(1.06, l); }
  function guyR() { return CONFIG.R0 * sizeMult(); }
  function dropCount() { return 1 + lvl('multi'); }
  function colorCount() {
    return Math.min(START_COLORS + lvl('colors'), PALETTE.length);
  }
  function varietyMult() {
    return 1 + CONFIG.VARIETY_BONUS * (colorCount() - START_COLORS);
  }
  function bardMult(l) { l = l == null ? lvl('bards') : l; return 1 + 0.08 * l; }
  function deepMult(l) { l = l == null ? lvl('deep') : l; return Math.pow(1.2, l); }
  function goldChance(l) {
    l = l == null ? lvl('gold') : l;
    if (Econ.era < 6) return 0.0005;
    return 0.002 + 0.004 * l;
  }
  function neckMult(l) { l = l == null ? lvl('neck') : l; return Math.pow(1.12, l); } // ✏️ TUNE: per-level throat-width step

  function sandPerGuy(r, gold) {
    var rr = (r || guyR()) / CONFIG.R0;
    return CONFIG.BASE_SAND * rr * rr * varietyMult() * bardMult() * deepMult() *
           (gold ? CONFIG.GOLD_MULT : 1);
  }
  function avgSandPerGuy() {
    return sandPerGuy() * (1 + goldChance() * (CONFIG.GOLD_MULT - 1));
  }
  function rainRate() { // sand/sec from the rain alone
    return dropCount() / dropInterval() * avgSandPerGuy();
  }
  function totalRate() {
    return rainRate() + (window.Society ? Society.incomeRate() : 0);
  }
  function drainRate() { // guys/sec through the neck while a mountain sits upstairs
    var g = Pile.glassRef;
    if (!g) return 0;
    var rel = g.neckHW / (guyR() * 2);
    var neckFlow = CONFIG.DRAIN_BASE * Math.max(0.4, rel * rel * 0.55);
    // sand pressure, matched by VOLUME: today's rain guys can be far chunkier
    // than the mountain's average grain (it remembers the small early eras), so
    // count-matching isn't enough — the mountain must shrink net in volume too
    var spawnFlow = dropCount() / dropInterval();
    var curArea = Math.PI * guyR() * guyR();
    var avgArea = Pile.top.count > 0 ? Math.max(Pile.top.avgArea, 1) : curArea;
    return Math.max(neckFlow, spawnFlow * 1.25 * (curArea / avgArea));
  }

  // PAY-AT-NECK: called the instant a live guy first crosses downward through
  // the neck (see physics.js step()'s wasAboveNeck transition), and reused as
  // an idempotent safety net elsewhere (b.earned guards every call site, so
  // calling this twice for the same guy is always harmless). The golden-guy
  // sparkle celebration is intentionally NOT here anymore — it fires at the
  // LANDING moment instead (physics.js settle block / pile.js bakeBody), so
  // payment and celebration can happen at two different places and times.
  function earnGuy(b) {
    if (b.earned) return;
    b.earned = true;
    // An atomized guy is drawn tiny but is paid for the sand he actually
    // carries (b.vol) — paying by his sprite would quietly delete the
    // difference between the mountain's worth and what the player receives.
    var rr = b.vol != null && b.vol > 0 ? Math.sqrt(b.vol / Math.PI) : b.r;
    var amount = Math.max(1, Math.round(sandPerGuy(rr, b.gold)));
    Econ.sand += amount;
    Econ.totalEarned += amount;
    if (window.FX) {
      FX.floater(b.x, b.y - b.r * 2, '+' + U.fmt(amount),
                 b.gold ? '#ffd700' : '#ffe9c2');
    }
  }

  // The bodyless half of the atomization stream (and the offline catch-up):
  // n guys of radius r cross the neck at once. Same price per guy as earnGuy,
  // one floater instead of n — so the unpaid debt clears at exactly the same
  // rate whether a guy got a body or not.
  function earnBulk(n, r) {
    if (!(n > 0)) return 0;
    var amount = Math.max(1, Math.round(sandPerGuy(r, false))) * n;
    Econ.sand += amount;
    Econ.totalEarned += amount;
    return amount;
  }

  // ---------- the flip, stage 2: how fast the mountain comes down ----------

  // A wider throat pours faster. Measured against the era's stock neck so the
  // Throat Polish upgrade is the only thing that moves it.
  function neckSpeed(g) {
    var stock = CONFIG.NECK_HW0 * Math.pow(CONFIG.NECK_GROWTH, (g.era || 1) - 1);
    return U.clamp(g.neckHW / Math.max(1e-6, stock), 1, 4);
  }

  // Guys/sec for the whole atomization stage, frozen when it starts.
  // Pinned to the rain's CURRENT volume rate rather than to a wall-clock
  // number: a player with a fast, chunky rain empties the top proportionally
  // faster, so the stage stays ~8-15% of the era at era 1 and at era 10 alike.
  function atomizeRate() {
    var g = Pile.glassRef;
    if (!g || Pile.top.count <= 0) return 0;
    var rainVol = dropCount() / dropInterval() * Math.PI * guyR() * guyR();
    var credit = Pile.top.volume / Pile.top.count;
    if (!(credit > 0)) return 0;
    return CONFIG.ATOMIZE_FLOW * neckSpeed(g) * rainVol / credit;
  }

  function earnPassive(dt) {
    var rate = window.Society ? Society.incomeRate() : 0;
    if (rate > 0) {
      Econ.sand += rate * dt;
      Econ.totalEarned += rate * dt;
    }
  }

  function eraName(era) {
    if (ERAS[era - 1]) return ERAS[era - 1].name;
    return 'The ' + era + 'th Era';
  }

  function visibleUpgrades() {
    var out = [];
    for (var i = 0; i < UPGRADES.length; i++) {
      if (Econ.era >= UPGRADES[i].era) out.push(UPGRADES[i]);
    }
    return out;
  }

  // population = every guy ever (they're all still in there)
  function population() { return Econ.counts.spawned; }

  Econ.lvl = lvl;
  Econ.def = def;
  Econ.costOf = costOf;
  Econ.isMaxed = isMaxed;
  Econ.canBuy = canBuy;
  Econ.buy = buy;
  Econ.dropInterval = dropInterval;
  Econ.sizeMult = sizeMult;
  Econ.guyR = guyR;
  Econ.dropCount = dropCount;
  Econ.colorCount = colorCount;
  Econ.varietyMult = varietyMult;
  Econ.goldChance = goldChance;
  Econ.neckMult = neckMult;
  Econ.sandPerGuy = sandPerGuy;
  Econ.avgSandPerGuy = avgSandPerGuy;
  Econ.rainRate = rainRate;
  Econ.totalRate = totalRate;
  Econ.drainRate = drainRate;
  Econ.atomizeRate = atomizeRate;
  Econ.neckSpeed = neckSpeed;
  Econ.earnGuy = earnGuy;
  Econ.earnBulk = earnBulk;
  Econ.earnPassive = earnPassive;
  Econ.eraName = eraName;
  Econ.visibleUpgrades = visibleUpgrades;
  Econ.population = population;

  window.Econ = Econ;
  if (typeof module !== 'undefined' && module.exports) module.exports = Econ;
})();
