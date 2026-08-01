/* The civilization on the pile. Small, charming, and doomed by design —
   the player's progress bar is their apocalypse. Global: Society */
(function () {
  'use strict';

  var structures = [];   // {t:'hut'|'tower', x, progress, done}
  var workers = [];      // cosmetic actors on the pile surface
  var pyramid = null;    // {x, n, t, phase:'rising'|'standing'|'none'}
  var buildCooldown = 6;
  var pyramidCooldown = 30;
  var doomsayer = null;  // {x} — appears when the end is near
  var vindicated = 0;    // how many times he's been proven right (gag throttle)

  function era() { return Econ.era; }
  function unlocked() { return era() >= 2; }

  function maxStructures() {
    return Math.min(10, 1 + Math.floor(Econ.lvl('builders') / 2) + Math.min(3, era() - 2));
  }
  function buildSpeed() { return 1 / (26 / (1 + Econ.lvl('builders') * 0.35)); } // progress/sec
  function workerTarget() {
    return unlocked() ? Math.min(14, 3 + Econ.lvl('builders') + (era() - 2)) : 0;
  }

  // pixel size of a structure (shared by rendering and collision)
  function sizeOf(s) {
    var g = Pile.glassRef;
    var v = g.capacity * (s.t === 'tower' ? 0.030 : 0.016);
    var w = Math.sqrt(v * (s.t === 'tower' ? 0.45 : 1.4));
    return { w: w, h: v / w };
  }

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

  function tick(dt) {
    if (!unlocked()) return;
    var g = Pile.glassRef;
    if (!g) return;

    // commission new structures — anchored to the surface where they're built
    buildCooldown -= dt;
    if (buildCooldown <= 0 && structures.length < maxStructures() && Pile.bottom.count > 25) {
      var wantTower = Econ.lvl('builders') >= 3 && Math.random() < 0.4;
      var sx = (Math.random() - 0.5) * g.bulbHW * 1.35;
      structures.push({
        t: wantTower ? 'tower' : 'hut',
        x: sx,
        baseY: Pile.surfaceAt(sx),
        progress: 0, done: false,
        seed: Math.random() * 1000
      });
      buildCooldown = 10 + Math.random() * 10;
      pushObstacles();
    }
    // build progress
    for (var i = 0; i < structures.length; i++) {
      var s = structures[i];
      if (!s.done) {
        s.progress += buildSpeed() * dt;
        if (s.progress >= 1) {
          s.progress = 1; s.done = true;
          if (window.Sound) Sound.tada();
          pushObstacles();
        }
      }
    }

    // pyramids
    if (era() >= 4 && Econ.lvl('stackers') > 0) {
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

    // workers wander
    var target = workerTarget();
    while (workers.length < target) {
      workers.push({ x: (Math.random() - 0.5) * g.bulbHW, dir: Math.random() < 0.5 ? -1 : 1,
                     phase: Math.random() * 10, carry: Math.random() < 0.5 });
    }
    if (workers.length > target) workers.length = target;
    for (var w = 0; w < workers.length; w++) {
      var wk = workers[w];
      wk.phase += dt * 6;
      wk.x += wk.dir * dt * CONFIG.R0 * 2.2;
      var lim = g.bulbHW * 0.85;
      if (wk.x > lim) wk.dir = -1;
      if (wk.x < -lim) wk.dir = 1;
      if (Math.random() < dt * 0.15) wk.dir *= -1;
    }

    // the Doomsayer
    if (Pile.fillFraction() >= CONFIG.DOOM_FILL && !doomsayer && Pile.bottom.count > 20) {
      doomsayer = { x: (Math.random() < 0.5 ? -1 : 1) * g.bulbHW * 0.55 };
      if (vindicated < 3) UI.toast('A prophet appears',
        'One little guy has made a sign. It says the end is near. The others are not listening.');
    }
    if (doomsayer && Pile.fillFraction() < CONFIG.DOOM_FILL * 0.9) doomsayer = null;
  }

  function flipDestroy() {
    var g = Pile.glassRef;
    for (var i = 0; i < structures.length; i++) {
      var s = structures[i];
      var y = Pile.surfaceAt(s.x);
      FX.debris(s.x, y - CONFIG.R0 * 2, s.t === 'tower' ? '#b78aff' : '#d9a066', 12, 420);
    }
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
    var hNow = h * (0.15 + 0.85 * p);
    ctx.save();
    ctx.translate(s.x, y);
    var wob = s.done ? 0 : Math.sin(s.seed + animClock * 7) * 0.02;
    ctx.rotate(wob);
    ctx.lineWidth = Math.max(2, w * 0.06);
    ctx.strokeStyle = '#241507';
    if (s.t === 'hut') {
      ctx.fillStyle = '#d9a066';
      ctx.fillRect(-w / 2, -hNow, w, hNow);
      ctx.strokeRect(-w / 2, -hNow, w, hNow);
      if (p > 0.6) { // roof
        ctx.fillStyle = '#a3543e';
        ctx.beginPath();
        ctx.moveTo(-w * 0.62, -hNow);
        ctx.lineTo(0, -hNow - h * 0.45);
        ctx.lineTo(w * 0.62, -hNow);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      if (p >= 1) { // door + warm window
        ctx.fillStyle = '#5b3a26';
        ctx.fillRect(-w * 0.13, -h * 0.42, w * 0.26, h * 0.42);
        ctx.fillStyle = '#ffd27a';
        ctx.fillRect(w * 0.18, -h * 0.66, w * 0.2, h * 0.2);
        ctx.strokeRect(w * 0.18, -h * 0.66, w * 0.2, h * 0.2);
      }
    } else { // tower
      ctx.fillStyle = '#b78e6a';
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
      ctx.strokeStyle = '#241507';
      ctx.lineWidth = Math.max(2, w * 0.06);
      if (p >= 1) { // crenellations + flag
        ctx.fillStyle = '#b78e6a';
        for (var c = -1; c <= 1; c++) {
          ctx.fillRect(c * w * 0.33 - w * 0.11, -hNow - h * 0.12, w * 0.22, h * 0.12);
          ctx.strokeRect(c * w * 0.33 - w * 0.11, -hNow - h * 0.12, w * 0.22, h * 0.12);
        }
        ctx.strokeStyle = '#241507';
        ctx.beginPath(); ctx.moveTo(0, -hNow - h * 0.12); ctx.lineTo(0, -hNow - h * 0.42); ctx.stroke();
        ctx.fillStyle = '#ff6b6b';
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

  var animClock = 0;

  function render(ctx, zoom) {
    if (!unlocked()) return;
    animClock += 1 / 60;
    var g = Pile.glassRef;
    var i;
    for (i = 0; i < structures.length; i++) drawStructure(ctx, structures[i]);

    // pyramid of guys
    if (pyramid) {
      var base = Pile.surfaceAt(pyramid.x);
      var r = CONFIG.R0;
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

    // workers (skip when too small to read)
    if (CONFIG.R0 * zoom > 1.6) {
      for (i = 0; i < workers.length; i++) {
        var w = workers[i];
        var busy = structures.some(function (s) { return !s.done; });
        drawMiniGuy(ctx, w.x, Pile.surfaceAt(w.x), CONFIG.R0 * 0.85,
                    PALETTE[i % Math.max(1, Econ.colorCount())].hex,
                    w.phase, busy && w.carry);
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
        drawMiniGuy(ctx, bx, by, CONFIG.R0 * 0.9, '#ffe066', animClock, false);
        // floating notes
        var nt = animClock % 2;
        ctx.globalAlpha = Math.max(0, 1 - nt);
        ctx.fillStyle = '#ffe066';
        ctx.font = '900 ' + CONFIG.R0 * 2.2 + 'px "Segoe UI", sans-serif';
        ctx.fillText('♪', bx + CONFIG.R0 * 2, by - CONFIG.R0 * 3 - nt * CONFIG.R0 * 4);
        ctx.globalAlpha = 1;
      }
    }

    // the Doomsayer and his sign
    if (doomsayer) {
      var dx = doomsayer.x, dy = Pile.surfaceAt(dx);
      var r2 = CONFIG.R0;
      drawMiniGuy(ctx, dx, dy, r2, '#c9cfe0', Math.sin(animClock * 3) * 0.3, false);
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
      ctx.fillText('THE END', 0, -r2 * 1.6);
      ctx.fillText('IS NEAR', 0, -r2 * 0.6);
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
    vindicated = (d && d.vindicated) || 0;
    if (d && d.structures) {
      for (var i = 0; i < d.structures.length; i++) {
        var s = d.structures[i];
        if (s.t !== 'hut' && s.t !== 'tower') continue;
        structures.push({ t: s.t, x: s.x, progress: s.p, done: s.p >= 1,
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
    tick: tick, render: render, flipDestroy: flipDestroy,
    structureVolume: structureVolume, incomeRate: incomeRate,
    serialize: serialize, restore: restore, reset: reset,
    get structuresRef() { return structures; }
  };
})();
