/* Save / load / export / import / offline progress. Global: Save
   Saves stay small forever: no per-guy data, just heightfields + histograms. */
(function () {
  'use strict';

  var KEY = 'ourglass-save-v1';
  var muted = false;
  var volumes = { music: 1, donk: 1, ping: 1 };
  var resetting = false; // blocks the unload-autosave from resurrecting a reset game

  function collect() {
    return {
      v: 1,
      t: Date.now(),
      era: Econ.era,
      sand: Math.floor(Econ.sand),
      earned: Math.floor(Econ.totalEarned),
      levels: Econ.levels,
      counts: Econ.counts,
      muted: muted,
      vol: { m: volumes.music, d: volumes.donk, p: volumes.ping },
      pile: Pile.serialize(),
      society: Society.serialize(),
      // mid-air guys ride along — nothing is ever lost, not even on reload
      live: Phys.bodies.map(function (b) {
        return [Math.round(b.x), Math.round(b.y), Math.round(b.r * 10),
                b.colorIdx, (b.gold ? 1 : 0) + (b.earned ? 2 : 0)];
      })
    };
  }

  function save() {
    if (resetting) return;                 // the player asked for a clean slate
    if (Flip.state === 'FLIPPING') return; // never snapshot mid-cinematic
    if (window.__noSave) return;           // dev modes never touch real saves
    try {
      localStorage.setItem(KEY, JSON.stringify(collect()));
    } catch (e) { /* storage full/blocked — the game must keep running */ }
  }

  function valid(d) {
    return d && d.v === 1 && typeof d.era === 'number' && d.era >= 1 && d.era < 200 &&
           isFinite(d.sand) && d.pile && typeof d.pile === 'object';
  }

  // A save is player-editable text (Import). Coerce everything numeric to a
  // finite number so a hand-mangled field can't NaN/Infinity-poison the game.
  function num(v, def, max) {
    v = Number(v);
    if (!isFinite(v) || v < 0) return def;
    return max != null && v > max ? max : v;
  }
  function numArr(a) {
    if (!Array.isArray(a)) return [];
    for (var i = 0; i < a.length; i++) a[i] = num(a[i], 0, 1e12);
    return a;
  }
  function sanitize(d) {
    d.era = Math.floor(num(d.era, 1, 199)) || 1;
    d.sand = num(d.sand, 0, 1e15);
    d.earned = num(d.earned, 0, 1e15);
    var lv = {};
    if (d.levels && typeof d.levels === 'object') {
      for (var i = 0; i < UPGRADES.length; i++) {
        var id = UPGRADES[i].id;
        lv[id] = Math.floor(num(d.levels[id], 0, UPGRADES[i].max || 999));
      }
    }
    d.levels = lv;
    var c = d.counts && typeof d.counts === 'object' ? d.counts : {};
    d.counts = { spawned: Math.floor(num(c.spawned, 0, 1e12)),
                 gold: Math.floor(num(c.gold, 0, 1e12)),
                 flips: Math.floor(num(c.flips, 0, 1e6)) };
    var p = d.pile;
    p.bvol = num(p.bvol, 0, 1e15); p.bcount = Math.floor(num(p.bcount, 0, 1e12));
    p.tvol = num(p.tvol, 0, 1e15); p.tcount = Math.floor(num(p.tcount, 0, 1e12));
    p.bh = numArr(p.bh); p.th = numArr(p.th);
    p.bhist = numArr(p.bhist); p.thist = numArr(p.thist);
    p.ov = num(p.ov, 0, 1e15);
    p.up = Math.floor(num(p.up, 0, 1e12));
    if (!Array.isArray(d.live)) d.live = [];
    return d;
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      return valid(d) ? d : null;
    } catch (e) { return null; }
  }

  function apply(d) {
    sanitize(d);
    Econ.era = d.era;
    Econ.sand = d.sand || 0;
    Econ.totalEarned = d.earned || 0;
    Econ.levels = d.levels || {};
    Econ.counts = d.counts || { spawned: 0, gold: 0, flips: 0 };
    muted = !!d.muted;
    if (d.vol && typeof d.vol === 'object') {
      volumes = { music: num(d.vol.m, 1, 1), donk: num(d.vol.d, 1, 1),
                  ping: num(d.vol.p, 1, 1) };
    }
    Main.rebuildGlassHard();   // builds glass for the era, Pile.init
    Pile.restore(d.pile);
    Society.restore(d.society);
    Phys.clear();
    if (d.live) {
      for (var i = 0; i < d.live.length; i++) {
        var l = d.live[i];
        Phys.spawn({ x: l[0], y: l[1], r: Math.max(2, l[2] / 10),
                     colorIdx: l[3] || 0, gold: !!(l[4] & 1), earned: !!(l[4] & 2) });
      }
    }
  }

  // Returns a report object if enough time passed to matter, else null.
  function processOffline(d, nowMs) {
    var away = ((nowMs || Date.now()) - (d.t || 0)) / 1000;
    if (!(away > 90)) return null;
    var capped = Math.min(away, CONFIG.OFFLINE_CAP_HOURS * 3600);
    var eff = CONFIG.OFFLINE_EFF;

    // society income
    var societySand = Society.incomeRate() * capped * eff;

    // the rain kept falling (until the chamber filled)
    var g = Main.glassRef();
    var guyArea = Math.PI * Econ.guyR() * Econ.guyR();
    var room = Math.max(0, g.capacity - Pile.bottom.volume - Society.structureVolume());
    var guysWanted = Math.floor(Econ.dropCount() / Econ.dropInterval() * capped * eff);
    var guys = Math.min(guysWanted, Math.floor(room / guyArea));
    var rainSand = 0;
    if (guys > 0) {
      Pile.captureRise();
      rainSand = guys * Econ.avgSandPerGuy();
      var colorN = Econ.colorCount();
      for (var i = 0; i < guys; i++) {
        var ci = (Math.random() * colorN) | 0;
        Pile.bottom.hist[ci] = (Pile.bottom.hist[ci] || 0) + 1;
      }
      Pile.bottom.count += guys;
      Pile.bottom.volume += guys * guyArea;
      Econ.counts.spawned += guys;
      // spread the new sand across the pile, then relax + redraw
      var chunks = Math.min(60, guys);
      for (var c = 0; c < chunks; c++) {
        Pile.addBottomVolume((Math.random() - 0.5) * g.bulbHW * 1.4,
                             guys * guyArea / chunks);
      }
      Pile.resynthesize();
      Pile.commitRise();
    }
    Econ.sand += societySand + rainSand;
    Econ.totalEarned += societySand + rainSand;

    return {
      seconds: away,
      guys: guys,
      sand: Math.floor(societySand + rainSand),
      full: Pile.fillFraction() >= 0.999   // the plain truth, however we got here
    };
  }

  // ---------- export / import ----------

  function exportString() {
    return 'OG1.' + btoa(unescape(encodeURIComponent(JSON.stringify(collect()))));
  }

  function importString(str) {
    try {
      str = (str || '').trim();
      if (str.indexOf('OG1.') !== 0) return 'That doesn\'t look like an Our Glass save.';
      var d = JSON.parse(decodeURIComponent(escape(atob(str.slice(4)))));
      if (!valid(d)) return 'That save file is damaged.';
      localStorage.setItem(KEY, JSON.stringify(d));
      location.reload();
      return null;
    } catch (e) {
      return 'That save file could not be read.';
    }
  }

  function reset() {
    resetting = true;
    try { localStorage.removeItem(KEY); } catch (e) {}
    location.reload();
  }

  window.Save = {
    save: save, load: load, apply: apply, processOffline: processOffline,
    exportString: exportString, importString: importString, reset: reset,
    collect: collect,
    get muted() { return muted; },
    set muted(m) { muted = m; },
    get volumes() { return volumes; }
  };
})();
