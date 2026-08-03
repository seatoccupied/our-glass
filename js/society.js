/* The civilization on the pile. Small, charming, and doomed by design —
   the player's progress bar is their apocalypse. Global: Society */
(function () {
  'use strict';

  var structures = [];   // {t:'hut'|'tower', x, progress, done, popT}
  var workers = [];      // cosmetic actors on the pile surface
  var pyramid = null;    // {x, n, t, phase:'rising'|'standing'|'none'}
  var buildCooldown = 6;
  var pyramidCooldown = 30;
  var doomsayer = null;  // {x, t, sign, camX, camY} — see spawnDoomsayer()
  var vindicated = 0;    // how many times he's been proven right (gag throttle)
  var doomed = [];       // structures hanging off the inverted pile mid-crush
  var animClock = 0;     // shared animation clock — advanced in tick() (dt-based) so
                          // render() can be called more than once per frame (js/doomcam.js
                          // does exactly that) without speeding animation up

  var POP_SECONDS = 0.35; // ✏️ TUNE: how long a structure's completion overshoot lasts

  // Rotating sign texts, dry deadpan "the end is near" energy. Each entry is
  // the sign's two lines. vindicated<=3 payoff cap is untouched — this only
  // changes what the sign SAYS, never how the prophecy gag is scored.
  var DOOM_SAYINGS = [
    ['THE END', 'IS NEAR'],
    ['WE ARE', 'ALL SAND'],
    ['GRAVITY', 'WINS'],
    ['NOBODY', 'LISTENS'],
    ['GLASS', 'WATCHES'],
    ['REPENT', "OR DON'T"],
    ['WE WERE', 'WARNED'],
    ['DOWN IS', 'DESTINY'],
    ['THE FLIP', 'AWAITS'],
    ['THIS TOO', 'WILL END']
  ];

  function era() { return Econ.era; }
  function unlocked() { return era() >= 2; }

  // s4 shelf: a shelved upgrade (config.js UPGRADES) silences the sim under
  // it too — no huts/towers while 'builders' is shelved, no pyramids while
  // 'stackers' is (Zach's full-off call, 2026-08-01). Workers, bards, and
  // the prophet stay on stage.
  function shelved(id) {
    for (var i = 0; i < UPGRADES.length; i++)
      if (UPGRADES[i].id === id) return !!UPGRADES[i].shelved;
    return false;
  }

  function maxStructures() {
    return Math.min(10, 1 + Math.floor(Econ.lvl('builders') / 2) + Math.min(3, era() - 2));
  }
  function buildSpeed() { return 1 / (26 / (1 + Econ.lvl('builders') * 0.35)); } // progress/sec
  function workerTarget() {
    if (shelved('builders')) return 0; // s4: Zach — empty stage while shelved
    return unlocked() ? Math.min(14, 3 + Econ.lvl('builders') + (era() - 2)) : 0;
  }

  // pixel size of a structure (shared by rendering and collision)
  function sizeOf(s) {
    var g = Pile.glassRef;
    var v = g.capacity * (s.t === 'tower' ? 0.030 : 0.016);
    var w = Math.sqrt(v * (s.t === 'tower' ? 0.45 : 1.4));
    return { w: w, h: v / w };
  }

  // The cast (workers, pyramid guys, bards, the Doomsayer + his sign) is a
  // constant CONFIG.R0 while the glass grows G^(era-1) per era, so by era 5-6
  // it's sub-pixel at default zoom (ROADMAP #7). Fix: scale it off the
  // glass's capacity growth, the same relative-to-capacity approach sizeOf()
  // already uses for structures — capacity grows with the SQUARE of the
  // glass's linear scale, so sqrt(capacity ratio) is exactly that linear
  // scale, and a cast radius of CONFIG.R0 * that scale renders at a constant
  // SCREEN size in every era (it cancels fitZoomFor()'s 1/scale shrink
  // exactly). Trade-off, taken deliberately per the roadmap: the cast ends
  // up proportionally larger than the true (constant-R0) sandmen as eras
  // climb — flagged for Zach's eye, not hidden.
  var CAST_CAP0 = null; // era-1 capacity, cached once
  function castScale() {
    var g = Pile.glassRef;
    if (!g) return 1;
    if (CAST_CAP0 == null) CAST_CAP0 = Glass.build(1, 1).capacity;
    return Math.sqrt(g.capacity / CAST_CAP0);
  }
  function castR() { return CONFIG.R0 * castScale(); }

  // structures are SOLID: sand piles against them, guys land on roofs
  function pushObstacles() {
    Pile.setObstacles(structures.map(function (s) {
      var dim = sizeOf(s);
      var hNow = dim.h * (0.15 + 0.85 * (s.done ? 1 : s.progress));
      return { x0: s.x - dim.w / 2, x1: s.x + dim.w / 2,
               y0: s.baseY - hNow, y1: s.baseY };
    }));
  }

  // Structure volumes are a fraction of chamber capacity — the works grow with
  // the civilization, and stay physically relevant to filling the glass.
  function volOf(s) {
    var g = Pile.glassRef;
    if (!g) return 0;
    var f = s.t === 'tower' ? 0.030 : 0.016;
    return g.capacity * f * (s.done ? 1 : s.progress * 0.5);
  }
  function structureVolume() {
    var v = 0;
    for (var i = 0; i < structures.length; i++) v += volOf(structures[i]);
    if (pyramid && pyramid.phase === 'standing') v += Pile.glassRef.capacity * 0.02;
    return v;
  }

  // Society income, as a share of rain income — stays relevant every era.
  function incomeRate() {
    var share = 0;
    for (var i = 0; i < structures.length; i++) {
      if (!structures[i].done) continue;
      share += structures[i].t === 'tower' ? 0.07 : 0.03;
    }
    if (pyramid && pyramid.phase === 'standing') share += 0.05;
    return Econ.rainRate() * share;
  }

  // Era-scaled material palette: tan huts / brown towers through era 3, cool
  // stone tones from era 4, gold trim from era 6 — "the society considers
  // them royalty" (config.js's own era-6 card). Fills only; geometry and ink
  // outlines are untouched (see the shared sizeOf contract, ROADMAP keeps).
  function eraPalette() {
    var e = era();
    if (e >= 6) return { wall: '#c7b98a', wall2: '#a8987a', roof: '#7a6142',
                          flag: '#ffd700', trim: '#ffd700' };
    if (e >= 4) return { wall: '#9aa3ab', wall2: '#868f99', roof: '#6b5a4a',
                          flag: '#ff6b6b', trim: null };
    return { wall: '#d9a066', wall2: '#b78e6a', roof: '#a3543e',
             flag: '#ff6b6b', trim: null };
  }

  function spawnDoomsayer(g) {
    // camX/camY start null (not yet drawn) — js/doomcam.js falls back to his
    // base position for the one frame before render() below fills them in
    return { x: (Math.random() < 0.5 ? -1 : 1) * g.bulbHW * 0.55, t: 0,
             sign: DOOM_SAYINGS[(Math.random() * DOOM_SAYINGS.length) | 0],
             camX: null, camY: null };
  }

  function tick(dt) {
    if (!unlocked()) return;
    var g = Pile.glassRef;
    if (!g) return;
    animClock += dt;

    // commission new structures — anchored to the surface where they're built
    buildCooldown -= dt;
    if (!shelved('builders') &&
        buildCooldown <= 0 && structures.length < maxStructures() && Pile.bottom.count > 25) {
      var wantTower = Econ.lvl('builders') >= 3 && Math.random() < 0.4;
      var sx = (Math.random() - 0.5) * g.bulbHW * 1.35;
      structures.push({
        t: wantTower ? 'tower' : 'hut',
        x: sx,
        baseY: Pile.surfaceAt(sx),
        progress: 0, done: false, popT: null,
        seed: Math.random() * 1000
      });
      buildCooldown = 10 + Math.random() * 10;
      pushObstacles();
    }
    // build progress + the completion pop (motion beat on top of the
    // existing door/window/crenellation state change — ROADMAP #8)
    for (var i = 0; i < structures.length; i++) {
      var s = structures[i];
      if (!s.done) {
        s.progress += buildSpeed() * dt;
        if (s.progress >= 1) {
          s.progress = 1; s.done = true; s.popT = 0;
          if (window.Sound) Sound.tada();
          if (window.FX) FX.puff(s.x, s.baseY, sizeOf(s).w * 0.6);
          pushObstacles();
        }
      } else if (s.popT != null && s.popT < POP_SECONDS) {
        s.popT += dt;
      }
    }

    // pyramids
    if (era() >= 4 && !shelved('stackers') && Econ.lvl('stackers') > 0) {
      if (!pyramid) {
        pyramidCooldown -= dt;
        if (pyramidCooldown <= 0 && Pile.bottom.count > 60) {
          pyramid = { x: (Math.random() - 0.5) * g.bulbHW * 0.9,
                      n: Math.min(5, 2 + Math.floor(Econ.lvl('stackers') / 2)),
                      t: 0, phase: 'rising' };
        }
      } else {
        pyramid.t += dt;
        if (pyramid.phase === 'rising' && pyramid.t > 6) {
          pyramid.phase = 'standing'; pyramid.t = 0;
        } else if (pyramid.phase === 'standing' && pyramid.t > 25 + Math.random() * 25) {
          // comic collapse — nobody is ever hurt
          FX.debris(pyramid.x, Pile.surfaceAt(pyramid.x) - CONFIG.R0 * 3,
                    PALETTE[(Math.random() * 3) | 0].hex, 10, 320);
          FX.puff(pyramid.x, Pile.surfaceAt(pyramid.x), CONFIG.R0 * 4);
          if (window.Sound) Sound.pop();
          pyramid = null;
          pyramidCooldown = 20 + Math.random() * 30 / (1 + Econ.lvl('stackers') * 0.3);
        }
      }
    }

    // workers: wander, or — while a structure is under construction — walk
    // to the site, help briefly, and wander off again (ROADMAP #21a). A
    // small state machine on top of the original wander loop, not a rewrite.
    var target = workerTarget();
    while (workers.length < target) {
      workers.push({ x: (Math.random() - 0.5) * g.bulbHW, dir: Math.random() < 0.5 ? -1 : 1,
                     phase: Math.random() * 10, state: 'wander', buildT: 0, targetX: 0 });
    }
    if (workers.length > target) workers.length = target;
    var busySites = null; // computed lazily, at most once per tick
    for (var w = 0; w < workers.length; w++) {
      var wk = workers[w];
      if (wk.state === 'toSite') {
        wk.phase += dt * 6;
        var dxw = wk.targetX - wk.x;
        wk.dir = dxw > 0 ? 1 : -1;
        var step = wk.dir * dt * CONFIG.R0 * 2.6; // a brisker pace, off to work
        if (Math.abs(dxw) <= Math.abs(step)) {
          wk.x = wk.targetX; wk.state = 'building'; wk.buildT = 1.1 + Math.random() * 0.9;
        } else wk.x += step;
      } else if (wk.state === 'building') {
        wk.phase += dt * 11; // a busier fidget while he's actually working
        wk.buildT -= dt;
        if (wk.buildT <= 0) { wk.state = 'wander'; wk.dir = Math.random() < 0.5 ? -1 : 1; }
      } else { // wander (default)
        wk.phase += dt * 6;
        wk.x += wk.dir * dt * CONFIG.R0 * 2.2;
        var lim = g.bulbHW * 0.85;
        if (wk.x > lim) wk.dir = -1;
        if (wk.x < -lim) wk.dir = 1;
        if (Math.random() < dt * 0.15) wk.dir *= -1;
        // a chance to head to an active build site
        if (busySites == null) busySites = structures.filter(function (st) { return !st.done; });
        if (busySites.length && Math.random() < dt * 0.1) {
          var site = busySites[(Math.random() * busySites.length) | 0];
          wk.state = 'toSite'; wk.targetX = site.x;
        }
      }
    }

    // the Doomsayer: the dramatic near-full PREDICTION only (s4: Zach cut the
    // unscheduled cameos — he shows up when the end really is near, keeping
    // the rotating sayings and the doomcam window).
    if (!doomsayer) {
      if (Pile.fillFraction() >= CONFIG.DOOM_FILL && Pile.bottom.count > 20) {
        doomsayer = spawnDoomsayer(g);
        if (vindicated < 3) UI.toast('A prophet appears',
          'One little guy has made a sign. It says the end is near. The others are not listening.');
      }
    } else {
      doomsayer.t += dt;
      if (Pile.fillFraction() < CONFIG.DOOM_FILL * 0.9) doomsayer = null;
    }
  }

  // THE FLIP, stage 1. The works aren't wiped at the instant of the flip any
  // more — they hang upside down off the underside of their own pile while it
  // falls, and each one is crushed out of existence as the collapse reaches it.
  // The mass visibly does the killing. (The guys are FINE — they ARE the sand.)
  // mapX turns an old-frame x into a new-frame one (the 180° mirror + the
  // era's growth); dur is the crush window the deaths are staggered across.
  function flipDoom(mapX, dur) {
    doomed = [];
    for (var i = 0; i < structures.length; i++) {
      var s = structures[i];
      doomed.push({ t: s.t, x: mapX(s.x), progress: s.progress, done: s.done,
                    seed: s.seed, dieIn: dur * (0.15 + 0.7 * Math.random()) });
    }
    // an on-stage prophecy pays out the "he was right" gag (capped at 3)
    if (doomsayer && vindicated < 3) {
      vindicated++;
      setTimeout(function () {
        UI.toast('The prophet was right',
          'Nobody listened. Everyone survived anyway. He has already started a new sign.');
      }, 6500);
    }
    structures = [];
    workers = [];
    pyramid = null;
    doomsayer = null;
    buildCooldown = 14; // they need a moment to grieve (and land)
    pyramidCooldown = 40;
    Pile.setObstacles([]);
  }

  function crushTick(dt) {
    for (var i = doomed.length - 1; i >= 0; i--) {
      var d = doomed[i];
      d.dieIn -= dt;
      if (d.dieIn > 0) continue;
      var y = Pile.topBaseAt(d.x);
      FX.debris(d.x, y, d.t === 'tower' ? '#b78aff' : '#d9a066', 12, 420);
      FX.puff(d.x, y, CONFIG.R0 * 3.5);
      if (window.Sound) Sound.pop();
      doomed.splice(i, 1);
    }
  }

  // ---------- rendering ----------

  function drawMiniGuy(ctx, x, y, r, hex, phase, carry) {
    var bob = Math.abs(Math.sin(phase)) * r * 0.35;
    ctx.save();
    ctx.translate(x, y - r - bob);
    ctx.fillStyle = hex;
    ctx.strokeStyle = U.shade(hex, -0.55);
    ctx.lineWidth = r * 0.2;
    // legs scurry
    ctx.lineCap = 'round';
    var lp = Math.sin(phase * 2) * 0.6;
    ctx.beginPath();
    ctx.moveTo(-r * 0.3, r * 0.5); ctx.lineTo(-r * 0.3 + Math.sin(lp) * r * 0.5, r * 1.1);
    ctx.moveTo(r * 0.3, r * 0.5); ctx.lineTo(r * 0.3 - Math.sin(lp) * r * 0.5, r * 1.1);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, r, 0, U.TAU); ctx.fill(); ctx.stroke();
    if (carry) { // carrying a brick overhead
      ctx.fillStyle = '#d9a066';
      ctx.strokeStyle = '#5b3a26';
      ctx.lineWidth = r * 0.15;
      ctx.fillRect(-r * 0.6, -r * 1.9, r * 1.2, r * 0.7);
      ctx.strokeRect(-r * 0.6, -r * 1.9, r * 1.2, r * 0.7);
    }
    ctx.restore();
  }

  function drawStructure(ctx, s) {
    var dim = sizeOf(s);
    var w = dim.w, h = dim.h;
    var y = s.baseY != null ? s.baseY : Pile.surfaceAt(s.x);
    var p = s.done ? 1 : s.progress;
    // a fast height-overshoot pop the instant the build finishes, decaying
    // back to normal over POP_SECONDS — the motion beat the sound/state
    // change (door, crenellations, flag) never had (ROADMAP #8)
    var pop = 0;
    if (s.done && s.popT != null && s.popT < POP_SECONDS) {
      var k = s.popT / POP_SECONDS;
      pop = Math.sin(Math.min(1, k) * Math.PI) * 0.22;
    }
    var hNow = h * (0.15 + 0.85 * p) * (1 + pop);
    var pal = eraPalette();
    ctx.save();
    ctx.translate(s.x, y);
    var wob = s.done ? 0 : Math.sin(s.seed + animClock * 7) * 0.02;
    ctx.rotate(wob);
    ctx.lineWidth = Math.max(2, w * 0.06);
    ctx.strokeStyle = '#241507';
    if (s.t === 'hut') {
      ctx.fillStyle = pal.wall;
      ctx.fillRect(-w / 2, -hNow, w, hNow);
      ctx.strokeRect(-w / 2, -hNow, w, hNow);
      if (p > 0.6) { // roof
        ctx.fillStyle = pal.roof;
        ctx.beginPath();
        ctx.moveTo(-w * 0.62, -hNow);
        ctx.lineTo(0, -hNow - h * 0.45);
        ctx.lineTo(w * 0.62, -hNow);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        if (p >= 1 && pal.trim) { // gold ridge cap, era 6+
          ctx.fillStyle = pal.trim;
          ctx.fillRect(-w * 0.1, -hNow - h * 0.46, w * 0.2, h * 0.055);
        }
      }
      if (p >= 1) { // door + warm window
        ctx.fillStyle = '#5b3a26';
        ctx.fillRect(-w * 0.13, -h * 0.42, w * 0.26, h * 0.42);
        ctx.fillStyle = '#ffd27a';
        ctx.fillRect(w * 0.18, -h * 0.66, w * 0.2, h * 0.2);
        ctx.strokeRect(w * 0.18, -h * 0.66, w * 0.2, h * 0.2);
      }
    } else { // tower
      ctx.fillStyle = pal.wall2;
      ctx.fillRect(-w / 2, -hNow, w, hNow);
      ctx.strokeRect(-w / 2, -hNow, w, hNow);
      // brick lines
      ctx.strokeStyle = 'rgba(36,21,7,0.35)';
      ctx.lineWidth = Math.max(1, w * 0.03);
      for (var yy = 1; yy < 5; yy++) {
        ctx.beginPath();
        ctx.moveTo(-w / 2, -hNow * yy / 5); ctx.lineTo(w / 2, -hNow * yy / 5);
        ctx.stroke();
      }
      if (pal.trim) { // gold banding under the parapet, era 6+
        ctx.fillStyle = pal.trim;
        ctx.fillRect(-w / 2, -hNow, w, Math.max(1.5, h * 0.025));
      }
      ctx.strokeStyle = '#241507';
      ctx.lineWidth = Math.max(2, w * 0.06);
      if (p >= 1) { // crenellations + flag
        ctx.fillStyle = pal.wall2;
        for (var c = -1; c <= 1; c++) {
          ctx.fillRect(c * w * 0.33 - w * 0.11, -hNow - h * 0.12, w * 0.22, h * 0.12);
          ctx.strokeRect(c * w * 0.33 - w * 0.11, -hNow - h * 0.12, w * 0.22, h * 0.12);
        }
        ctx.strokeStyle = '#241507';
        ctx.beginPath(); ctx.moveTo(0, -hNow - h * 0.12); ctx.lineTo(0, -hNow - h * 0.42); ctx.stroke();
        ctx.fillStyle = pal.flag;
        ctx.beginPath();
        ctx.moveTo(0, -hNow - h * 0.42);
        ctx.lineTo(w * 0.34, -hNow - h * 0.34);
        ctx.lineTo(0, -hNow - h * 0.26);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
    // construction scaffold
    if (!s.done) {
      ctx.strokeStyle = 'rgba(217,160,102,0.7)';
      ctx.lineWidth = Math.max(1.5, w * 0.035);
      ctx.beginPath();
      ctx.moveTo(-w * 0.68, 0); ctx.lineTo(-w * 0.68, -hNow - h * 0.2);
      ctx.moveTo(w * 0.68, 0); ctx.lineTo(w * 0.68, -hNow - h * 0.2);
      ctx.moveTo(-w * 0.68, -hNow * 0.6); ctx.lineTo(w * 0.68, -hNow * 0.6);
      ctx.stroke();
    }
    ctx.restore();
  }

  // the doomed works, hanging upside down from the underside of the falling
  // mass — drawn before the unlocked() gate so they still show mid-crush
  function renderDoomed(ctx) {
    for (var i = 0; i < doomed.length; i++) {
      var d = doomed[i];
      ctx.save();
      ctx.translate(d.x, Pile.topBaseAt(d.x));
      ctx.rotate(Math.PI);
      drawStructure(ctx, { t: d.t, x: 0, baseY: 0, progress: d.progress,
                           done: d.done, seed: d.seed });
      ctx.restore();
    }
  }

  function render(ctx, zoom) {
    if (doomed.length) renderDoomed(ctx);
    if (!unlocked()) return;
    var g = Pile.glassRef;
    var i;
    var cr = castR(); // the cast's world-unit radius this frame (constant screen size)
    for (i = 0; i < structures.length; i++) drawStructure(ctx, structures[i]);

    // pyramid of guys
    if (pyramid) {
      var base = Pile.surfaceAt(pyramid.x);
      var r = cr;
      var rows = pyramid.phase === 'rising'
        ? Math.max(1, Math.ceil(pyramid.n * Math.min(1, pyramid.t / 6)))
        : pyramid.n;
      for (var row = 0; row < rows; row++) {
        var inRow = pyramid.n - row;
        for (var k = 0; k < inRow; k++) {
          var px = pyramid.x + (k - (inRow - 1) / 2) * r * 2.05;
          var py = base - r - row * r * 1.8;
          drawMiniGuy(ctx, px, py + r, r,
            PALETTE[(row + k) % Math.max(1, Econ.colorCount())].hex,
            animClock * 2 + k, false);
        }
      }
    }

    // workers (skip only when the inset/zoom is too small to read at all —
    // castR() keeps this true at default zoom in every era, ROADMAP #7)
    if (cr * zoom > 1.6) {
      for (i = 0; i < workers.length; i++) {
        var w = workers[i];
        var atWork = w.state === 'toSite' || w.state === 'building';
        drawMiniGuy(ctx, w.x, Pile.surfaceAt(w.x), cr * 0.85,
                    PALETTE[i % Math.max(1, Econ.colorCount())].hex,
                    w.phase, atWork);
      }
    }

    // bards on the tallest done structure
    if (era() >= 5 && Econ.lvl('bards') > 0) {
      var tallest = null, ty = 1e9;
      for (i = 0; i < structures.length; i++) {
        if (!structures[i].done) continue;
        var sy = Pile.surfaceAt(structures[i].x);
        if (sy < ty) { ty = sy; tallest = structures[i]; }
      }
      if (tallest) {
        var v2 = g.capacity * (tallest.t === 'tower' ? 0.030 : 0.016);
        var w2 = Math.sqrt(v2 * (tallest.t === 'tower' ? 0.45 : 1.4));
        var h2 = v2 / w2;
        var bx = tallest.x, by = ty - h2 * (tallest.t === 'tower' ? 1.12 : 1.0);
        drawMiniGuy(ctx, bx, by, cr * 0.9, '#ffe066', animClock, false);
        // floating notes
        var nt = animClock % 2;
        ctx.globalAlpha = Math.max(0, 1 - nt);
        ctx.fillStyle = '#ffe066';
        ctx.font = '900 ' + cr * 2.2 + 'px "Segoe UI", sans-serif';
        ctx.fillText('♪', bx + cr * 2, by - cr * 3 - nt * cr * 4);
        ctx.globalAlpha = 1;
      }
    }

    // the Doomsayer and his sign
    if (doomsayer) {
      var dx = doomsayer.x, dy = Pile.surfaceAt(dx);
      var r2 = cr;
      var wobPhase = Math.sin(animClock * 3) * 0.3;
      var bobVal = Math.abs(Math.sin(wobPhase)) * r2 * 0.35;
      // exact drawn center this frame — js/doomcam.js locks its camera here
      // so he sits rock-steady in the inset while the world sways around him
      doomsayer.camX = dx; doomsayer.camY = dy - r2 - bobVal;
      drawMiniGuy(ctx, dx, dy, r2, '#c9cfe0', wobPhase, false);
      ctx.save();
      ctx.translate(dx + r2 * 1.6, dy - r2 * 2.2);
      ctx.rotate(Math.sin(animClock * 3) * 0.07);
      ctx.strokeStyle = '#5b3a26';
      ctx.lineWidth = r2 * 0.25;
      ctx.beginPath(); ctx.moveTo(0, r2 * 2.2); ctx.lineTo(0, 0); ctx.stroke();
      ctx.fillStyle = '#e8e2d0';
      ctx.strokeStyle = '#241507';
      ctx.lineWidth = r2 * 0.18;
      ctx.fillRect(-r2 * 2.4, -r2 * 2.6, r2 * 4.8, r2 * 2.6);
      ctx.strokeRect(-r2 * 2.4, -r2 * 2.6, r2 * 4.8, r2 * 2.6);
      ctx.fillStyle = '#a33';
      ctx.font = '900 ' + r2 * 0.85 + 'px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      var sign = doomsayer.sign || DOOM_SAYINGS[0];
      ctx.fillText(sign[0], 0, -r2 * 1.6);
      ctx.fillText(sign[1], 0, -r2 * 0.6);
      ctx.restore();
    }
  }

  // ---------- save ----------

  function serialize() {
    return {
      structures: structures.map(function (s) {
        return { t: s.t, x: Math.round(s.x), p: Math.round(s.progress * 100) / 100 };
      }),
      vindicated: vindicated
    };
  }
  function restore(d) {
    structures = [];
    workers = [];
    pyramid = null;
    doomsayer = null;
    doomed = [];
    vindicated = (d && d.vindicated) || 0;
    if (d && d.structures) {
      for (var i = 0; i < d.structures.length; i++) {
        var s = d.structures[i];
        if (s.t !== 'hut' && s.t !== 'tower') continue;
        structures.push({ t: s.t, x: s.x, progress: s.p, done: s.p >= 1, popT: null,
                          baseY: Pile.surfaceAt(s.x),
                          seed: Math.random() * 1000 });
      }
      pushObstacles();
    }
  }
  // post-flip reset — the prophet's track record survives (it's his whole bit,
  // and the gag throttle depends on it)
  function reset() {
    var v = vindicated;
    restore(null);
    vindicated = v;
  }

  window.Society = {
    tick: tick, render: render, flipDoom: flipDoom, crushTick: crushTick,
    structureVolume: structureVolume, incomeRate: incomeRate,
    serialize: serialize, restore: restore, reset: reset,
    castR: castR, // js/doomcam.js needs this to frame him consistently every era
    get structuresRef() { return structures; },
    get doomedRef() { return doomed; },
    get doomsayerRef() { return doomsayer; }
  };
})();
