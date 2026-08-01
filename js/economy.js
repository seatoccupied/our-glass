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

  function dropInterval() {
    return Math.max(0.07, CONFIG.BASE_DROP_INTERVAL * Math.pow(0.88, lvl('rate')));
  }
  function sizeMult() { return Math.pow(1.06, lvl('size')); }
  function guyR() { return CONFIG.R0 * sizeMult(); }
  function dropCount() { return 1 + lvl('multi'); }
  function colorCount() {
    return Math.min(START_COLORS + lvl('colors'), PALETTE.length);
  }
  function varietyMult() {
    return 1 + CONFIG.VARIETY_BONUS * (colorCount() - START_COLORS);
  }
  function bardMult() { return 1 + 0.08 * lvl('bards'); }
  function deepMult() { return Math.pow(1.2, lvl('deep')); }
  function goldChance() {
    if (Econ.era < 6) return 0.0005;
    return 0.002 + 0.004 * lvl('gold');
  }
  function neckMult() { return Math.pow(1.12, lvl('neck')); }

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

  function earnGuy(b) {
    if (b.earned) return;
    b.earned = true;
    var amount = Math.max(1, Math.round(sandPerGuy(b.r, b.gold)));
    Econ.sand += amount;
    Econ.totalEarned += amount;
    if (window.FX) {
      FX.floater(b.x, b.y - b.r * 2, '+' + U.fmt(amount),
                 b.gold ? '#ffd700' : '#ffe9c2');
      if (b.gold) FX.sparkleAt(b.x, b.y, b.r * 3);
    }
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
  Econ.earnGuy = earnGuy;
  Econ.earnPassive = earnPassive;
  Econ.eraName = eraName;
  Econ.visibleUpgrades = visibleUpgrades;
  Econ.population = population;

  window.Econ = Econ;
  if (typeof module !== 'undefined' && module.exports) module.exports = Econ;
})();
