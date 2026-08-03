/* The pile system — population tiers 2 and 3.
   bottom: settled guys baked into a sprite canvas + collision heightfield.
   top:    the flipped mountain — volume + color histogram + heightfield,
           drawn as speckle mass.
   Conservation: live + top.count + bottom.count === totalSpawned. Always.

   THE FLIP, STAGES 1 AND 2 (stage 0, the rotation, lives in flip.js/main.js):
   1. CRUSH — at rotation end the old bottom pile is upside down at the top of
      the new glass, hanging from the ceiling. It free-falls onto the funnel
      (per-column, so the edges land before the deep center) and then avalanches
      at high speed into an even settled mass. `topBase[]` is what makes this
      possible: it's the y of the mass's UNDERSIDE per column, normally equal to
      funnelBaseY(i) and only airborne during the crush.
   2. ATOMIZE — the settled mass erodes from the neck outward and comes back as
      little guys. Two paths, both count-exact:
        • the live stream: real tiny bodies, throttled to a share of the free
          LIVE_CAP slots so fresh rain still gets somewhere to land;
        • bulk conversion: the remainder of the tick's budget moves top→bottom
          as heightfield volume (at late eras the count is far beyond anything
          260 live bodies could carry, and at that zoom one guy is sub-pixel).
      THE VOLUME-CREDIT INVARIANT: a tiny guy is DRAWN at ATOMIZE_R_FRAC of its
      true size but carries `b.vol` = its full share of the mountain
      (top.volume / top.count at the moment it leaves). The top is debited that
      volume on release and the bottom is credited exactly the same number on
      bake — so the bottom pile grows by precisely as much as the mountain
      shrank. Nothing is ever lost, in count OR in volume. */
(function () {
  'use strict';

  var glass = null;
  var MAX_COLS = 1200;             // heightfield resolution cap — render loops
                                   // stay O(1200) no matter how huge the glass gets
  var colW = CONFIG.R0 * 0.9;
  var cols = 0, x0 = 0;            // column layout spans [-span, span]
  var floorY = null, ceilY = null; // bottom chamber bounds per column
  var funnelY = null, hole = null; // top chamber funnel floor + drain hole

  var bottom = { h: null, hist: [], volume: 0, count: 0 };
  var top    = { h: null, hist: [], volume: 0, count: 0, avgArea: Math.PI * 100,
                 unpaid: 0 }; // guys who landed on the mountain but haven't
                              // been paid — they earn when they reach the bottom

  // y of the mass's UNDERSIDE per column. Normally funnelBaseY(i) — the mass
  // rests on the funnel. Lifted above it only while the crush is falling.
  var topBase = null;
  var crush = null;   // {t, dur, vel, acc, landed} — stage 1, null the rest of the time
  var atom = { active: false, rate: 0, acc: 0 }; // stage 2; rate is guys/sec, frozen at start

  var pileCanvas = null, pileCtx = null, pcScale = 1, pcX = 0, pcY = 0;
  var massPattern = null;
  var drainAcc = 0;
  var riseFrom = null, riseT = 1; // offline catch-up: the pile visibly rises
  var topOverflow = 0;  // mass volume that physically can't fit below the rim
  var settleAcc = 0;    // background relax timer — piles always slump to repose
  var obstAdd = null;   // phantom solid height per column (structure bodies)
  var obstMin = null;   // foundation floor — sand under a house can't drain away
  var obstacleBoxes = []; // structure AABBs for the physics (guys land on roofs)

  function colX(i) { return x0 + (i + 0.5) * colW; }

  var GRAIN_WORLD_CAP = 60;   // ✏️ TUNE hard ceiling on live FX.grain particles at once
  var GRAIN_PER_HEIGHT = 6;   // ✏️ TUNE world-units of transferred height per extra grain
  var GRAIN_MAX_BURST = 5;    // ✏️ TUNE grains spawned from a single topple event

  // A big topple kicks up a visible spray rolling downhill, scaled to how
  // much sand actually moved (`amount`, the height relaxBottom/relaxTop just
  // transferred) — a whole slope collapsing (post-flip crush landing, an
  // atomization dump) should read as a spray, not one stray speck. Bounded
  // per-event AND by the shared FX particle budget so it never gets disco-y.
  function grainAt(i, surfFn, dir, amount) {
    if (!window.FX || !glass) return;
    var room = GRAIN_WORLD_CAP - FX.worldList.length;
    if (room <= 0) return;
    var n = Math.max(1, Math.min(GRAIN_MAX_BURST, room,
                                  Math.round((amount || 0) / GRAIN_PER_HEIGHT)));
    var hist = surfFn === topSurfY ? top.hist : bottom.hist;
    var total = 0, k;
    for (k = 0; k < hist.length; k++) total += hist[k] || 0;
    for (var g = 0; g < n; g++) {
      var pick = 0;
      if (total > 0) {
        var rnd = Math.random() * total;
        for (k = 0; k < hist.length; k++) {
          rnd -= hist[k] || 0;
          if (rnd <= 0) { pick = k; break; }
        }
      }
      FX.grain(colX(i) + (Math.random() - 0.5) * colW * 0.6, surfFn(i) - CONFIG.R0 * 0.4, dir,
               PALETTE[pick] ? PALETTE[pick].hex : '#d9b877');
    }
  }
  function colAt(x) {
    var i = Math.floor((x - x0) / colW);
    return i < 0 ? 0 : (i >= cols ? cols - 1 : i);
  }

  function init(g, keepTop) {
    glass = g;
    var span = g.bulbHW + CONFIG.R0 * 2;
    x0 = -span;
    colW = Math.max(CONFIG.R0 * 0.9, (span * 2) / MAX_COLS);
    cols = Math.max(8, Math.ceil((span * 2) / colW));
    floorY = new Float64Array(cols);
    ceilY = new Float64Array(cols);
    funnelY = new Float64Array(cols);
    hole = new Uint8Array(cols);
    for (var i = 0; i < cols; i++) {
      var x = colX(i);
      var ax = Math.abs(x);
      // outside-the-glass columns ground at the glass BOTTOM, not neck height —
      // a transient escapee must fall, never hover on a phantom ledge
      floorY[i] = ax >= g.bulbHW ? g.floorY : g.lowerFloorY(x);
      // ceiling of the bottom chamber (underside of the taper). Open in the middle.
      ceilY[i] = ax < g.neckHW ? g.neckTopY : bottomCeil(ax);
      hole[i] = ax < g.neckHW ? 1 : 0;
      funnelY[i] = ax >= g.bulbHW ? g.rimY : g.upperFloorY(x);
    }
    bottom.h = new Float64Array(cols);
    bottom.hist = []; bottom.volume = 0; bottom.count = 0;
    obstAdd = new Float64Array(cols);
    obstMin = new Float64Array(cols);
    obstacleBoxes = [];
    topBase = new Float64Array(cols);
    for (var j = 0; j < cols; j++) topBase[j] = funnelBaseY(j);
    crush = null;
    if (!keepTop) {
      top.h = new Float64Array(cols);
      top.hist = []; top.volume = 0; top.count = 0; top.unpaid = 0;
    }
    buildPileCanvas();
    massPattern = null;
  }

  function bottomCeil(ax) {
    // walk the flare section (neck -> bottom bulb widest) for the crossing
    var p = glass.profile;
    for (var i = 0; i < p.length - 1; i++) {
      var a = p[i], b = p[i + 1];
      if (a.y < glass.neckBottomY - 1e-6) continue;
      if (a.hw <= ax && b.hw >= ax) {
        var t = (ax - a.hw) / (b.hw - a.hw || 1e-9);
        return a.y + (b.y - a.y) * t;
      }
    }
    return glass.neckBottomY;
  }

  function buildPileCanvas() {
    var padX = CONFIG.R0 * 3, padY = CONFIG.R0 * 3;
    var w = (glass.bulbHW + padX) * 2;
    var h = (glass.floorY + padY) - glass.neckTopY;
    pcScale = Math.min(2, 4096 / w, Math.sqrt(12e6 / (w * h)));
    pcX = -(glass.bulbHW + padX);
    pcY = glass.neckTopY;
    pileCanvas = document.createElement('canvas');
    pileCanvas.width = Math.max(4, Math.ceil(w * pcScale));
    pileCanvas.height = Math.max(4, Math.ceil(h * pcScale));
    pileCtx = pileCanvas.getContext('2d');
    pileCtx.setTransform(pcScale, 0, 0, pcScale, -pcX * pcScale, -pcY * pcScale);
  }

  // ---------- heightfield helpers ----------

  function bottomSurfY(i) {
    return floorY[i] - bottom.h[i] - (obstAdd ? obstAdd[i] : 0);
  }

  function relaxBottom(iMin, iMax) {
    iMin = Math.max(0, iMin); iMax = Math.min(cols - 1, iMax);
    var maxStep = CONFIG.SLOPE_MAX * colW;
    for (var pass = 0; pass < 4; pass++) {
      var moved = false;
      for (var i = iMin; i < iMax; i++) {
        var a = bottomSurfY(i), b = bottomSurfY(i + 1);
        var diff = b - a; // positive: right side lower
        // probabilistic toppling: jittered threshold + partial transfers make
        // slopes creep and roll to rest instead of snapping (research: piles
        // read as flowing sand this way — arXiv 2008.06341)
        var jit = maxStep * (0.75 + Math.random() * 0.5);
        var rate = 0.25 + Math.random() * 0.35;
        if (diff > jit) {
          var t = (diff - maxStep) * rate;
          var avail = bottom.h[i] - obstMin[i]; // foundations stay put
          if (avail < t) t = Math.max(0, avail);
          bottom.h[i] -= t; bottom.h[i + 1] += t; moved = moved || t > 0;
          if (t > colW * 0.5) grainAt(i + 1, bottomSurfY, 1, t);
        } else if (-diff > jit) {
          var t2 = (-diff - maxStep) * rate;
          var avail2 = bottom.h[i + 1] - obstMin[i + 1];
          if (avail2 < t2) t2 = Math.max(0, avail2);
          bottom.h[i + 1] -= t2; bottom.h[i] += t2; moved = moved || t2 > 0;
          if (t2 > colW * 0.5) grainAt(i, bottomSurfY, -1, t2);
        }
      }
      // clamp under the chamber ceiling
      for (var j = iMin; j <= iMax; j++) {
        var cap = floorY[j] - ceilY[j];
        if (bottom.h[j] > cap && !hole[j]) {
          var ex = bottom.h[j] - cap;
          bottom.h[j] = cap;
          var dir = colX(j) > 0 ? -1 : 1;
          var k = j + dir;
          if (k >= 0 && k < cols) bottom.h[k] += ex;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  function addBottomVolume(x, area) {
    var i = colAt(x);
    var spread = 2;
    var per = area / (spread * 2 + 1) / colW;
    for (var k = -spread; k <= spread; k++) {
      var j = Math.max(0, Math.min(cols - 1, i + k));
      bottom.h[j] += per;
    }
    relaxBottom(i - 30, i + 30);
  }

  // ---------- ground queries (physics calls this a lot) ----------

  // interpolate a surface between column centers so coarse columns at huge
  // eras still give smooth ground
  function lerpSurf(surfFn, x) {
    var f = (x - x0) / colW - 0.5;
    var i0 = Math.max(0, Math.min(cols - 1, Math.floor(f)));
    var i1 = Math.min(cols - 1, i0 + 1);
    var t = U.clamp(f - i0, 0, 1);
    return U.lerp(surfFn(i0), surfFn(i1), t);
  }

  function groundAt(x, y) {
    if (!glass) return null;
    var i = colAt(x);
    if (y < glass.neckTopY) {
      // Mid-crush the mass is a falling slab and every live guy up here is
      // UNDER it (they were standing on the pile that just turned over). Ground
      // queries snap a body to the surface from whichever side it's on, which
      // would suck them up through the slab — so the mass simply isn't ground
      // until it lands. They fall out ahead of it, which is the whole image.
      if (crush) return null;
      // top chamber: mass surface only where mass exists
      if (top.count > 0 && top.h[i] > 0.5) {
        var sy = lerpSurf(topSurfY, x);
        var l = i > 0 ? topSurfY(i - 1) : sy;
        var r = i < cols - 1 ? topSurfY(i + 1) : sy;
        return { y: sy, slope: (r - l) / (2 * colW) };
      }
      return null; // bare funnel = glass walls handle it
    }
    var syb = lerpSurf(bottomSurfY, x);
    var lb = i > 0 ? bottomSurfY(i - 1) : syb;
    var rb = i < cols - 1 ? bottomSurfY(i + 1) : syb;
    return { y: syb, slope: (rb - lb) / (2 * colW) };
  }

  // ---------- baking ----------

  // An atomized tiny guy is drawn small but carries a full share of the
  // mountain (b.vol) — see the volume-credit invariant up top. Everything that
  // moves sand around asks for the volume through here, never πr².
  function volOfBody(b) {
    return b.vol != null && b.vol > 0 ? b.vol : Math.PI * b.r * b.r;
  }

  // Paint ink to match the volume a body actually adds to the heightfield.
  // An atomized tiny guy bakes as ONE grain at his volume-equivalent radius —
  // exactly the circle a normal guy of that sand would leave. (The old
  // approach scattered N tiny stamps at his drawn size; random scatter can't
  // tile an area, and the shortfall accumulated into dark voids inside the
  // pile — Zach's s4 viewfinder catch.)
  function stampForVolume(b, area) {
    var rEq = Math.sqrt(area / Math.PI);
    if (rEq <= b.r * 1.05) { Guys.stampGuy(pileCtx, b); return; }
    Guys.stampGuy(pileCtx, {
      x: b.x, y: b.y, r: rEq, angle: b.angle || 0, colorIdx: b.colorIdx,
      gold: b.gold, face: b.face, squash: 0
    });
  }

  function bakeBody(b) {
    var area = volOfBody(b);
    if (b.y < glass.neckTopY) {
      // became part of the mountain upstairs
      top.hist[b.colorIdx] = (top.hist[b.colorIdx] || 0) + 1;
      top.count++; top.volume += area;
      top.avgArea = top.volume / top.count;
      var ti = colAt(b.x);
      var roomT = (topBase[ti] - glass.rimY) - top.h[ti];
      if (area / colW <= roomT) top.h[ti] += area / colW;
      else topOverflow += area; // the chamber is full to the brim — bank it
      relaxTop();
      massPattern = null; // colors changed a bit
      // pay-at-neck: a guy that bakes into the mountain without ever crossing
      // the neck (never earned) doesn't lose its value — its worth joins the
      // existing top-side unpaid-debt bookkeeping and pays out later when the
      // drain finally carries it (or its statistical stand-in) through.
      if (!b.earned) { top.unpaid++; b.earned = true; }
      // landing sparkle fallback: a golden guy that gets force-baked under
      // LIVE_CAP pressure without ever passing through the settle/sleep
      // "landing" moment (physics.js) still deserves its celebration — this
      // bake IS its landing in that rare case. b.settled means it already
      // got its sparkle there, so don't double-fire.
      if (b.gold && !b.settled && window.FX) FX.sparkleAt(b.x, b.y, b.r * 3);
    } else {
      bottom.hist[b.colorIdx] = (bottom.hist[b.colorIdx] || 0) + 1;
      bottom.count++; bottom.volume += area;
      stampForVolume(b, area);
      addBottomVolume(b.x, area);
      Econ.earnGuy(b); // safety net — see physics.js settle-block comment
      if (b.gold && !b.settled && window.FX) FX.sparkleAt(b.x, b.y, b.r * 3);
    }
  }

  // ---------- the flip, stage 1: the inverted pile crushes down ----------

  // Called the instant the world finishes rotating. The old bottom pile is now
  // upside down above everyone; we rebuild it in the NEW (bigger) glass as a
  // slab hanging from the ceiling, keeping its silhouette and its exact volume.
  function flipToTop(newGlass, oldGlass) {
    var vol = bottom.volume, count = bottom.count;
    var hist = bottom.hist.slice();
    var carryTopVol = top.volume, carryTopCount = top.count; // usually 0
    var carryUnpaid = top.unpaid; // bottom guys are all paid; old debt carries
    for (var i = 0; i < top.hist.length; i++) hist[i] = (hist[i] || 0) + (top.hist[i] || 0);

    // snapshot the old shape before init() throws the column layout away
    var oldH = bottom.h, oldCols = cols, oldColW = colW, oldX0 = x0;
    var oldBulbHW = (oldGlass || glass).bulbHW;

    init(newGlass, false);
    top.volume = vol + carryTopVol;
    top.count = count + carryTopCount;
    top.unpaid = carryUnpaid;
    top.hist = hist;
    top.avgArea = top.count > 0 ? top.volume / top.count : Math.PI * 100;
    atom.active = false; atom.rate = 0; atom.acc = 0;

    // Resample the old shape into the new columns, mirrored in x (that's the
    // 180°) and stretched so the old chamber's full width covers the new one.
    // Keeping it at old-world scale would leave a small blob hugging the middle
    // of a much wider ceiling; stretching it keeps the read — "the whole
    // chamber is hanging over us" — while the height scaling below keeps the
    // VOLUME honest, which is the number that actually matters.
    var shape = new Float64Array(cols), sum = 0, j;
    for (j = 0; j < cols; j++) {
      var u = colX(j) / glass.bulbHW;
      if (u < -1 || u > 1) continue;
      var oi = Math.round((-u * oldBulbHW - oldX0) / oldColW - 0.5);
      if (oi < 0) oi = 0; else if (oi >= oldCols) oi = oldCols - 1;
      shape[j] = oldH ? oldH[oi] : 0;
      sum += shape[j] * colW;
    }
    if (sum > 1e-9 && top.volume > 0) {
      var k = top.volume / sum;
      for (j = 0; j < cols; j++) top.h[j] = shape[j] * k;
      // hang it from the ceiling: the old pile's SURFACE is now its underside
      for (j = 0; j < cols; j++) {
        topBase[j] = top.h[j] > 0.5
          ? Math.min(funnelBaseY(j), glass.rimY + top.h[j])
          : funnelBaseY(j);
      }
      crushBegin(CONFIG.FLIP_CRUSH_SECONDS);
    } else {
      // no shape to invert (a fresh save, or a test that faked the volume):
      // just lay the mass down where it belongs and skip the collapse
      pourTop(top.volume);
    }
  }

  function crushBegin(dur) {
    var maxFall = 0;
    for (var i = 0; i < cols; i++) {
      var d = funnelBaseY(i) - topBase[i];
      if (d > maxFall) maxFall = d;
    }
    // Solve the acceleration instead of picking one: the column with the
    // longest drop lands exactly at CRUSH_FALL_FRAC of the window, at every
    // era, so a glass 100× taller still collapses on the same beat.
    var tFall = Math.max(0.05, dur * CONFIG.CRUSH_FALL_FRAC);
    crush = { t: 0, dur: dur, vel: 0, acc: 2 * maxFall / (tFall * tFall), landed: false };
  }

  function crushTick(dt) {
    if (!crush) return;
    crush.t += dt;
    crush.vel += crush.acc * dt;
    var allDown = true, i;
    for (i = 0; i < cols; i++) {
      var rest = funnelBaseY(i);
      if (topBase[i] >= rest) { topBase[i] = rest; continue; }
      topBase[i] = Math.min(rest, topBase[i] + crush.vel * dt);
      if (topBase[i] < rest) allDown = false;
    }
    if (allDown) {
      // landed — now it crushes itself flat, fast (the same avalanche the
      // pile uses all game, just run many passes per frame)
      if (!crush.landed) {
        crush.landed = true;
        if (window.Sound) Sound.boom();
        if (window.FX) {
          FX.puff(0, glass.neckTopY, glass.bulbHW * 0.5);
          FX.puff(-glass.bulbHW * 0.45, glass.neckTopY, glass.bulbHW * 0.35);
          FX.puff(glass.bulbHW * 0.45, glass.neckTopY, glass.bulbHW * 0.35);
        }
      }
      for (var p = 0; p < CONFIG.CRUSH_RELAX_PASSES; p++) relaxTop();
    }
    if (crush.t >= crush.dur) crushEnd();
  }

  function crushEnd() {
    if (!crush) return;
    crush = null;
    for (var i = 0; i < cols; i++) topBase[i] = funnelBaseY(i);
    for (var p = 0; p < 8; p++) relaxTop();
    atomizeBegin();
  }

  // ---------- the flip, stage 2: atomization ----------

  // Volume per remaining mountain guy, read LIVE rather than frozen at the
  // flip: rain that settles on the mountain mid-stage joins top.volume and
  // top.count together, so this ratio stays exact instead of drifting.
  function topCredit() {
    return top.count > 0 ? top.volume / top.count : 0;
  }

  function atomizeBegin() {
    if (top.count <= 0) { atom.active = false; atom.rate = 0; return; }
    atom.active = true;
    atom.acc = 0;
    atom.rate = Econ.atomizeRate(); // frozen: the stage has a planned length
  }

  function atomizeEnd() { atom.active = false; atom.rate = 0; atom.acc = 0; }

  // distribute a volume into the top funnel with a flat-ish surface
  function pourTop(V) {
    if (V <= 0) return;
    var lo = glass.rimY, hi = glass.neckTopY; // surface level search range
    for (var it = 0; it < 40; it++) {
      var mid = (lo + hi) / 2, vol = 0;
      for (var i = 0; i < cols; i++) {
        var base = funnelBaseY(i);
        if (base > mid) vol += (base - mid) * colW;
      }
      if (vol > V) lo = mid; else hi = mid;
    }
    var Ys = (lo + hi) / 2;
    var placed = 0;
    for (var j = 0; j < cols; j++) {
      var b = funnelBaseY(j);
      topBase[j] = b;               // a pour always lands; nothing stays airborne
      top.h[j] = Math.max(0, b - Ys);
      placed += top.h[j] * colW;
    }
    topOverflow += Math.max(0, V - placed); // more than the chamber holds
    // gentle mound: relax makes it settle into repose
    relaxTop();
  }

  function funnelBaseY(i) {
    // hole columns rest on "neck top" — the mass plugs the hole
    return hole[i] ? glass.neckTopY : funnelY[i];
  }

  // Where the mass's surface is. topBase is its underside — the funnel floor
  // normally, higher up while a crush is still falling.
  function topSurfY(i) { return topBase[i] - top.h[i]; }

  function relaxTop() {
    var maxStep = CONFIG.SLOPE_MAX * colW;
    for (var pass = 0; pass < 4; pass++) {
      var moved = false;
      for (var i = 0; i < cols - 1; i++) {
        if (top.h[i] <= 0 && top.h[i + 1] <= 0) continue;
        var a = topSurfY(i), b = topSurfY(i + 1);
        var diff = b - a;
        var jit = maxStep * (0.75 + Math.random() * 0.5);
        var rate = 0.25 + Math.random() * 0.35;
        if (diff > jit) {
          var t = Math.min((diff - maxStep) * rate, top.h[i]);
          if (t > 0) {
            top.h[i] -= t; top.h[i + 1] += t; moved = true;
            if (t > colW * 0.5) grainAt(i + 1, topSurfY, 1, t);
          }
        } else if (-diff > jit) {
          var t2 = Math.min((-diff - maxStep) * rate, top.h[i + 1]);
          if (t2 > 0) {
            top.h[i + 1] -= t2; top.h[i] += t2; moved = true;
            if (t2 > colW * 0.5) grainAt(i, topSurfY, -1, t2);
          }
        }
      }
      if (!moved) break;
    }
    // rim cap: no mountain ever pokes out of the glass. Excess goes to the
    // overflow bank; banked volume pours back the moment room opens up.
    var j, cap, room;
    for (j = 0; j < cols; j++) {
      cap = Math.max(0, topBase[j] - glass.rimY);
      if (top.h[j] > cap) { topOverflow += (top.h[j] - cap) * colW; top.h[j] = cap; }
    }
    if (topOverflow > 0) {
      for (j = 0; j < cols && topOverflow > 0; j++) {
        cap = Math.max(0, topBase[j] - glass.rimY);
        room = cap - top.h[j];
        if (room > 0) {
          var put = Math.min(room, topOverflow / colW);
          top.h[j] += put; topOverflow -= put * colW;
        }
      }
    }
  }

  // ---------- draining ----------

  function drainStep(dt, ratePerSec) {
    if (crush) return;             // the mass is still in the air — nothing pours yet
    if (top.count <= 0) { if (atom.active) atomizeEnd(); return; }

    var atomizing = atom.active;
    var rate = atomizing ? Math.max(ratePerSec, atom.rate) : ratePerSec;

    // a real hourglass backs up: when the mound under the neck has no headroom,
    // the flow pauses until avalanching spreads it. (Without this, the mound
    // slams into the chamber ceiling and guys stand on an invisible flare.)
    // This gates LIVE bodies only — bulk conversion is heightfield arithmetic,
    // it can't stand on an invisible ledge, and stalling it is exactly the
    // "the mountain jams the top chamber all era" problem we're killing.
    var ci0 = colAt(0);
    var centerSurf = Math.min(bottomSurfY(ci0),
                              bottomSurfY(Math.max(0, ci0 - 2)),
                              bottomSurfY(Math.min(cols - 1, ci0 + 2)));
    var backedUp = centerSurf - glass.neckBottomY < CONFIG.R0 * 4;
    if (backedUp) relaxBottom(0, cols - 1); // help the mound spread
    if (backedUp && !atomizing) return;

    // cap the backlog: after a stall the drain resumes as a stream, not a bomb
    drainAcc = Math.min(drainAcc + rate * dt, atomizing ? Math.max(30, rate) : 30);

    // The live stream takes a SHARE of the free slots, never all of them —
    // fresh rain has to keep landing during the pour or the sky goes quiet.
    var free = Math.max(0, CONFIG.LIVE_CAP - 10 - Phys.bodies.length);
    var liveBudget = atomizing ? Math.floor(free * CONFIG.ATOMIZE_SLOT_SHARE)
                               : (free > 0 ? 9 : 0); // the ordinary trickle, unchanged
    var released = 0;
    while (drainAcc >= 1 && top.count > 0 && released < liveBudget && released < 24) {
      drainAcc -= 1;
      releaseOne();
      released++;
    }
    // Whatever the live cap couldn't carry converts straight across as volume.
    // Same count, same sand, same colors — just no body to watch. At the eras
    // where this fires, one guy is a fraction of a pixel.
    if (atomizing && drainAcc >= 1 && top.count > 0 && !backedUp) {
      var n = Math.min(Math.floor(drainAcc), top.count);
      drainAcc -= n;
      bulkConvert(n);
    }
    if (top.count <= 0 && atom.active) atomizeEnd();
  }

  // pick a color proportionally from what's left up there (and spend it)
  function pickTopColor() {
    var total = 0, i;
    for (i = 0; i < top.hist.length; i++) total += top.hist[i] || 0;
    if (total <= 0) return 0;
    var rnd = Math.random() * total;
    for (i = 0; i < top.hist.length; i++) {
      rnd -= top.hist[i] || 0;
      if (rnd <= 0) { top.hist[i]--; return i; }
    }
    return 0;
  }

  // take `area` worth of material out of the mountain, center columns first
  function erodeTop(area) {
    var need = area / colW, ci = colAt(0), k = 0;
    while (need > 0 && k < cols) {
      var j = ci + (k % 2 === 0 ? k / 2 : -(k + 1) / 2); // 0, +1, -1, +2, -2…
      k++;
      if (j < 0 || j >= cols) continue;
      var take = Math.min(top.h[j], need);
      top.h[j] -= take; need -= take;
    }
    if (need > 0 && topOverflow > 0) { // the shape ran dry; draw on the bank
      topOverflow -= Math.min(need * colW, topOverflow);
    }
  }

  function releaseOne() {
    var pick = pickTopColor();
    var area = atom.active ? topCredit() : top.avgArea;
    top.count--; top.volume = Math.max(0, top.volume - area);
    if (top.count > 0) top.avgArea = top.volume / top.count; // Econ.drainRate reads this
    erodeTop(area);
    relaxTop();

    // clamp: a corrupted volume/count ratio must never spawn kaiju sandmen
    var trueR = Math.sqrt(Math.max(1, area) / Math.PI);
    var r = atom.active
      ? U.clamp(trueR * CONFIG.ATOMIZE_R_FRAC, CONFIG.R0 * 0.3, CONFIG.R0 * 1.2)
      : U.clamp(trueR, CONFIG.R0 * 0.55, CONFIG.R0 * 2.4);
    // PAY-AT-NECK handoff (see js/physics.js wasAboveNeck): mass that was
    // already paid for crosses the neck marked earned and costs nothing. The
    // unpaid remainder pays out one guy at a time until the debt is gone, so
    // the total paid over the whole stream is exactly top.unpaid at the flip.
    var owed = top.unpaid > 0;
    if (owed) top.unpaid--;
    Phys.spawn({
      x: (Math.random() - 0.5) * glass.neckHW * 0.8,
      y: glass.neckTopY + r * 1.2,
      vx: (Math.random() - 0.5) * 30, vy: 60,
      r: r, colorIdx: pick, earned: !owed,
      vol: atom.active ? area : null
    });
    if (top.count === 0) { top.volume = 0; top.hist = []; }
  }

  // The no-body path: n guys move top -> bottom as pure volume. Count-exact
  // and sand-exact; only the little bodies are missing.
  function bulkConvert(n) {
    n = Math.min(n, top.count);
    if (n <= 0) return;
    var credit = topCredit();
    var area = credit * n;

    var owed = Math.min(n, top.unpaid);
    if (owed > 0) {
      top.unpaid -= owed;
      Econ.earnBulk(owed, Math.sqrt(Math.max(1, credit) / Math.PI));
    }

    // colors move across in proportion — the old population keeps its mix
    var total = 0, i;
    for (i = 0; i < top.hist.length; i++) total += top.hist[i] || 0;
    var left = n;
    for (i = 0; i < top.hist.length && left > 0; i++) {
      var have = top.hist[i] || 0;
      if (have <= 0) continue;
      var take = Math.min(have, left, Math.round(n * have / Math.max(1, total)));
      top.hist[i] = have - take;
      bottom.hist[i] = (bottom.hist[i] || 0) + take;
      left -= take;
    }
    for (i = 0; i < top.hist.length && left > 0; i++) { // rounding leftovers
      var t2 = Math.min(top.hist[i] || 0, left);
      if (t2 <= 0) continue;
      top.hist[i] -= t2; bottom.hist[i] = (bottom.hist[i] || 0) + t2; left -= t2;
    }
    if (left > 0) bottom.hist[0] = (bottom.hist[0] || 0) + left;

    top.count -= n; top.volume = Math.max(0, top.volume - area);
    if (top.count > 0) top.avgArea = top.volume / top.count; // Econ.drainRate reads this
    bottom.count += n; bottom.volume += area;
    erodeTop(area);
    relaxTop();

    // land it as a spread of chunks so the pile grows evenly, and paint only
    // the band that just appeared (a full resynthesize is O(cols × depth) and
    // is brutal at late eras — this costs about one stamp per arriving guy)
    var before = bottom.h.slice();
    var chunks = Math.min(10, Math.max(1, n));
    for (var c = 0; c < chunks; c++) {
      addBottomVolume((Math.random() - 0.5) * glass.bulbHW * 1.5, area / chunks);
    }
    paintBand(before);
    if (top.count === 0) { top.volume = 0; top.hist = []; }
  }

  // Repaint only the freshly-buried band between the old surface and the new
  // one. Cost is proportional to the sand that just arrived, not to the pile.
  function paintBand(before) {
    if (bottom.count <= 0) return;
    var rAvg = Math.sqrt((bottom.volume / bottom.count) / Math.PI);
    if (!(rAvg > 0.5)) return;
    var total = 0, c;
    for (c = 0; c < bottom.hist.length; c++) total += bottom.hist[c] || 0;
    if (total <= 0) return;
    for (var i = 0; i < cols; i++) {
      var yNew = bottomSurfY(i);
      var yOld = floorY[i] - before[i] - (obstAdd ? obstAdd[i] : 0);
      if (yOld - yNew < rAvg) continue;
      for (var y = yOld; y > yNew - rAvg * 0.4; y -= rAvg * 1.55) {
        var pick = 0, rnd = Math.random() * total;
        for (c = 0; c < bottom.hist.length; c++) {
          rnd -= bottom.hist[c] || 0;
          if (rnd <= 0) { pick = c; break; }
        }
        Guys.stampGuy(pileCtx, {
          x: colX(i) + (Math.random() - 0.5) * colW * 0.9,
          y: y + (Math.random() - 0.5) * rAvg * 0.5,
          r: rAvg * (0.9 + Math.random() * 0.2),
          angle: Math.random() * U.TAU,
          colorIdx: pick, gold: false, face: 0, squash: 0
        });
      }
    }
  }

  // ---------- rendering ----------

  // "While you were away": capture before, commit after, and render clips the
  // pile to a surface that rises from the old height to the new one.
  function captureRise() { riseFrom = bottom.h.slice(); }
  function commitRise() { if (riseFrom) riseT = 0; }

  function render(ctx) {
    if (riseT < 1 && riseFrom && riseFrom.length === cols) {
      riseT = Math.min(1, riseT + 1 / 200);
      var e = U.easeInOutCubic(riseT);
      ctx.save();
      ctx.beginPath();
      var pad = CONFIG.R0 * 3;
      ctx.moveTo(x0, glass.floorY + pad);
      for (var i = 0; i < cols; i++) {
        var sy = floorY[i] - U.lerp(riseFrom[i], bottom.h[i], e);
        ctx.lineTo(colX(i), sy - CONFIG.R0);
      }
      ctx.lineTo(-x0, glass.floorY + pad);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(pileCanvas, pcX, pcY,
                    pileCanvas.width / pcScale, pileCanvas.height / pcScale);
      ctx.restore();
      if (riseT >= 1) riseFrom = null;
    } else {
      ctx.drawImage(pileCanvas, pcX, pcY,
                    pileCanvas.width / pcScale, pileCanvas.height / pcScale);
    }
    if (top.count > 0) renderTopMass(ctx);
    drawGlints(ctx);
  }

  // the Journey trick, 2D-ified: a scatter of twinkling specks along the sand
  // surfaces. Pure rendering — makes the mass read as sand, not paint.
  var glintT = 0;
  var GLINT_BASE = 14;      // ✏️ TUNE glint count on a small early pile
  var GLINT_PER_COL = 1 / 40; // ✏️ TUNE glints added per heightfield column
  var GLINT_MAX = 60;       // ✏️ TUNE hard cap so a mega pile doesn't disco
  function drawGlints(ctx) {
    glintT += 1 / 60;
    var slot = Math.floor(glintT * 0.7);
    // scale with pile width (cols) so a 9,000-guy mountain reads as sandier
    // than a 33-guy starter pile without the small case getting glint-bare
    var glintCount = Math.min(GLINT_MAX, GLINT_BASE + cols * GLINT_PER_COL);
    ctx.save();
    for (var k = 0; k < glintCount; k++) {
      // pseudo-random but stable within a ~1.4s slot, so glints wink in place
      var seed = Math.sin(k * 127.3 + slot * 311.7) * 43758.5453;
      var f = seed - Math.floor(seed);
      var i = Math.floor(f * cols);
      var onTop = top.count > 0 && f > 0.5;
      var h = onTop ? top.h[i] : bottom.h[i];
      if (h < CONFIG.R0) continue;
      var sy = onTop ? topSurfY(i) : bottomSurfY(i);
      var tw = Math.sin(glintT * 4 + k * 2.1);
      if (tw < 0.2) continue;
      ctx.globalAlpha = tw * 0.3;
      ctx.fillStyle = '#fff6dd';
      var s = CONFIG.R0 * 0.22;
      ctx.fillRect(colX(i) - s / 2 + (f - 0.5) * colW * 2, sy + CONFIG.R0 * 0.4, s, s);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function renderTopMass(ctx) {
    if (!massPattern) massPattern = buildMassPattern();
    ctx.beginPath();
    var started = false, i;
    // mid-crush only the mass itself is drawn — a bare funnel column would
    // trail a skirt down from a slab that hasn't landed yet
    var wide = !crush;
    for (i = 0; i < cols; i++) {
      if (top.h[i] > 0.5 || (wide && !hole[i] && funnelY[i] > glass.rimY + 1)) {
        var sx = colX(i), sy = topSurfY(i);
        if (!started) { ctx.moveTo(sx, topBase[i]); ctx.lineTo(sx, sy); started = true; }
        else ctx.lineTo(sx, sy);
      }
    }
    for (i = cols - 1; i >= 0; i--) {
      if (top.h[i] > 0.5 || (wide && !hole[i] && funnelY[i] > glass.rimY + 1)) {
        ctx.lineTo(colX(i), topBase[i]);
      }
    }
    ctx.closePath();
    ctx.save();
    ctx.fillStyle = massPattern;
    ctx.fill();
    ctx.restore();
    // cel outline along the surface
    ctx.beginPath();
    var st = false;
    for (i = 0; i < cols; i++) {
      if (top.h[i] > 0.5) {
        var px = colX(i), py = topSurfY(i);
        if (!st) { ctx.moveTo(px, py); st = true; } else ctx.lineTo(px, py);
      }
    }
    ctx.lineWidth = Math.max(2, CONFIG.R0 * 0.35);
    ctx.strokeStyle = 'rgba(20,26,48,0.8)';
    ctx.stroke();
  }

  function buildMassPattern() {
    var tile = document.createElement('canvas');
    var TS = 96;
    tile.width = TS; tile.height = TS;
    var tc = tile.getContext('2d');
    // base: darkened average of the histogram colors
    var mix = mixHistColor(top.hist);
    tc.fillStyle = U.shade(mix, -0.55);
    tc.fillRect(0, 0, TS, TS);
    var rng = U.rng(12345);
    var total = 0, i;
    for (i = 0; i < top.hist.length; i++) total += top.hist[i] || 0;
    for (var d = 0; d < 42; d++) {
      var pick = 0;
      if (total > 0) {
        var rnd = rng() * total;
        for (i = 0; i < top.hist.length; i++) {
          rnd -= top.hist[i] || 0;
          if (rnd <= 0) { pick = i; break; }
        }
      }
      var hex = PALETTE[pick] ? PALETTE[pick].hex : '#c9a86a';
      var r = TS * 0.055 * (0.8 + rng() * 0.5);
      var x = rng() * TS, y = rng() * TS;
      tc.fillStyle = U.shade(hex, -0.25);
      tc.beginPath(); tc.arc(x, y, r, 0, U.TAU); tc.fill();
      tc.fillStyle = U.shade(hex, -0.6);
      tc.beginPath(); tc.arc(x, y, r, 0, U.TAU); tc.lineWidth = 1.5;
      tc.strokeStyle = U.shade(hex, -0.6); tc.stroke();
    }
    var pat = pileCtx.createPattern(tile, 'repeat');
    // scale the pattern so a tile dot reads about guy-sized in world units
    var scale = (CONFIG.R0 * 1.15) / (TS * 0.055);
    pat.setTransform(new DOMMatrix([scale, 0, 0, scale, 0, 0]));
    return pat;
  }

  function mixHistColor(hist) {
    var r = 0, g = 0, b = 0, n = 0;
    for (var i = 0; i < hist.length; i++) {
      var c = hist[i] || 0;
      if (!c || !PALETTE[i]) continue;
      var hex = PALETTE[i].hex;
      r += parseInt(hex.slice(1, 3), 16) * c;
      g += parseInt(hex.slice(3, 5), 16) * c;
      b += parseInt(hex.slice(5, 7), 16) * c;
      n += c;
    }
    if (!n) return '#c9a86a';
    function h2(v) { return ('0' + Math.round(v / n).toString(16)).slice(-2); }
    return '#' + h2(r) + h2(g) + h2(b);
  }

  // ---------- save / restore ----------

  function serialize() {
    function ser(hf) {
      var out = new Array(hf.length);
      for (var i = 0; i < hf.length; i++) out[i] = Math.round(hf[i] * 10) / 10;
      return out;
    }
    return {
      bh: ser(bottom.h), bhist: bottom.hist, bvol: Math.round(bottom.volume),
      bcount: bottom.count,
      th: ser(top.h), thist: top.hist, tvol: Math.round(top.volume),
      tcount: top.count, ov: Math.round(topOverflow), up: top.unpaid,
      // mid-atomization state: two numbers, so a reload mid-pour keeps pouring
      at: atom.active ? 1 : 0, ar: Math.round(atom.rate * 100) / 100
    };
  }

  function restore(d) {
    function res(arr, target) {
      // resample if the column count changed between versions
      if (!arr || !arr.length) return;
      for (var i = 0; i < target.length; i++) {
        var t = arr.length === target.length ? i
              : (i / (target.length - 1)) * (arr.length - 1);
        var i0 = Math.floor(t), i1 = Math.min(arr.length - 1, i0 + 1);
        target[i] = U.lerp(arr[i0], arr[i1], t - i0);
      }
    }
    res(d.bh, bottom.h);
    // heal saves from the wall-escape bug: material that baked outside the
    // glass spreads evenly back across the chamber (nothing is ever lost,
    // not even to a bug — and no towering wall-wings either)
    var recovered = 0, interior = [], ci;
    for (ci = 0; ci < cols; ci++) {
      var ax2 = Math.abs(colX(ci));
      if (ax2 >= glass.bulbHW * 0.97) { recovered += bottom.h[ci]; bottom.h[ci] = 0; }
      else if (ax2 < glass.bulbHW * 0.85) interior.push(ci);
    }
    if (recovered > 0 && interior.length) {
      var per = recovered / interior.length;
      for (ci = 0; ci < interior.length; ci++) bottom.h[interior[ci]] += per;
    }
    relaxBottom(0, cols - 1);
    bottom.hist = d.bhist || []; bottom.volume = d.bvol || 0; bottom.count = d.bcount || 0;
    res(d.th, top.h);
    top.hist = d.thist || []; top.volume = d.tvol || 0; top.count = d.tcount || 0;
    top.avgArea = top.count > 0 ? top.volume / top.count : Math.PI * 100;
    top.unpaid = Math.min(d.up || 0, top.count);
    topOverflow = d.ov || 0;
    crush = null;                                   // never saved mid-cinematic
    for (var tb = 0; tb < cols; tb++) topBase[tb] = funnelBaseY(tb);
    atom.active = !!d.at && top.count > 0;
    atom.rate = atom.active ? (d.ar > 0 ? d.ar : Econ.atomizeRate()) : 0;
    atom.acc = 0;
    if (top.count > 0) relaxTop(); // rim-caps oversized restored mountains
    // settle hard on load: undoes ceiling-domes and heal-lumps from old bugs,
    // then the repaint below matches paint to the true surface
    for (var rlx = 0; rlx < 30; rlx++) relaxBottom(0, cols - 1);
    resynthesize();
  }

  // Rebuild the bottom pile sprite canvas from heightfield + histogram.
  // Arrangement reshuffles; shape, colors and counts are what's preserved.
  function resynthesize() {
    pileCtx.save();
    pileCtx.setTransform(1, 0, 0, 1, 0, 0);
    pileCtx.clearRect(0, 0, pileCanvas.width, pileCanvas.height);
    pileCtx.restore();
    if (bottom.count <= 0) return;
    var rAvg = Math.sqrt((bottom.volume / bottom.count) / Math.PI);
    var rng = U.rng(9177);
    var total = 0, i;
    for (i = 0; i < bottom.hist.length; i++) total += bottom.hist[i] || 0;
    for (i = 0; i < cols; i++) {
      var x = colX(i);
      var yTop = bottomSurfY(i);
      for (var y = floorY[i] - rAvg * 0.8; y > yTop + rAvg * 0.4; y -= rAvg * 1.55) {
        var pick = 0;
        if (total > 0) {
          var rnd = rng() * total;
          for (var c = 0; c < bottom.hist.length; c++) {
            rnd -= bottom.hist[c] || 0;
            if (rnd <= 0) { pick = c; break; }
          }
        }
        // never paint sand inside a building
        var inBox = false;
        for (var ob = 0; ob < obstacleBoxes.length; ob++) {
          var bb = obstacleBoxes[ob];
          if (x >= bb.x0 && x <= bb.x1 && y >= bb.y0 && y <= bb.y1) { inBox = true; break; }
        }
        if (inBox) continue;
        Guys.stampGuy(pileCtx, {
          x: x + (rng() - 0.5) * colW * 0.9,
          y: y + (rng() - 0.5) * rAvg * 0.5,
          r: rAvg * (0.9 + rng() * 0.2),
          angle: rng() * U.TAU,
          colorIdx: pick, gold: false,
          face: (rng() * 3) | 0, squash: 0
        });
      }
    }
  }

  // background settling: piles always slump toward natural slopes, even when
  // nothing new lands (heals odd shapes from loads, drains, old bugs)
  function settleTick(dt) {
    if (crush) return;   // crushTick owns the top while it's collapsing
    settleAcc += dt;
    if (settleAcc >= 0.5) {
      settleAcc = 0;
      relaxBottom(0, cols - 1);
      if (top.count > 0) relaxTop();
    }
  }

  // Every cubic unit currently counted toward the fill readout: the baked
  // bottom pile, the living surface skin (settled guys not yet baked), and
  // any structures. Shared by fillFraction() and the dev FILL TO 95% tool so
  // both agree on what "full" means.
  function currentVolume() {
    if (!glass) return 0;
    var skin = 0, bs = window.Phys ? Phys.bodies : [];
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      if (b.settled && b.y >= glass.neckTopY) skin += volOfBody(b);
    }
    return bottom.volume + skin + (window.Society ? Society.structureVolume() : 0);
  }

  function fillFraction() {
    if (!glass) return 0;
    // s4 TOWER-FILL (Zach's wide-glass inversion): the level clears when the
    // pile's PEAK — baked heightfield plus the living settled guys riding on
    // it — reaches the red line at the throat's mouth (neckBottomY). A
    // tighter throttle funnels the rain into a narrower, taller tower, so
    // the upgrade directly buys faster levels.
    var goal = glass.floorY - glass.neckBottomY;
    var peakY = glass.floorY;
    for (var i = 0; i < cols; i++) {
      var y = bottomSurfY(i);
      if (y < peakY) peakY = y;
    }
    // the tower's top layers are LIVE (settled/sleeping, not yet baked)
    var bs = window.Phys ? Phys.bodies : [];
    for (var k = 0; k < bs.length; k++) {
      var b = bs[k];
      if ((b.settled || b.sleeping) && b.y > glass.neckTopY &&
          b.y - b.r < peakY) peakY = b.y - b.r;
    }
    return Math.min(1.25, (glass.floorY - peakY) / Math.max(1, goal));
  }

  // ---------- dev tools (?dev=1 only — see js/ui.js) ----------
  // Both functions add mass through the SAME legitimate paths a real bake
  // uses: bottom.count and Econ.counts.spawned move together (conservation:
  // live + top.count + bottom.count === spawned always holds), and the sand
  // is paid through Econ.earnBulk — the identical bulk-payment path
  // bulkConvert() uses when the atomization stream drops guys with no body.
  // Nothing here bypasses the invariant; it just skips the wait.
  function devPourBottom(volume) {
    if (!glass || !(volume > 0)) return 0;
    var r = window.Econ ? Econ.guyR() : CONFIG.R0;
    var area = Math.max(1, Math.PI * r * r);
    var n = Math.max(1, Math.round(volume / area));
    var actualVol = n * area;

    // color mix: proportional to whatever's already in the pile; falls back
    // to an even spread across the unlocked palette for a fresh pile
    var colorsN = window.Econ ? Econ.colorCount() : 1;
    var totalHist = 0, ci;
    for (ci = 0; ci < bottom.hist.length; ci++) totalHist += bottom.hist[ci] || 0;
    var left = n;
    if (totalHist > 0) {
      for (ci = 0; ci < colorsN && left > 0; ci++) {
        var have = bottom.hist[ci] || 0;
        var take = Math.min(left, Math.round(n * have / totalHist));
        if (take <= 0) continue;
        bottom.hist[ci] = have + take;
        left -= take;
      }
    }
    if (left > 0) {
      var per = Math.floor(left / colorsN), rem = left % colorsN;
      for (ci = 0; ci < colorsN; ci++) {
        var add = per + (ci < rem ? 1 : 0);
        if (add > 0) bottom.hist[ci] = (bottom.hist[ci] || 0) + add;
      }
    }

    bottom.count += n;
    bottom.volume += actualVol;
    if (window.Econ) {
      Econ.counts.spawned += n;   // keeps live + top.count + bottom.count === spawned
      Econ.earnBulk(n, r);        // paid exactly like a normal bake — see bulkConvert()
    }

    var chunks = Math.min(10, Math.max(1, n));
    var before = bottom.h.slice();
    for (var c = 0; c < chunks; c++) {
      addBottomVolume((Math.random() - 0.5) * glass.bulbHW * 1.5, actualVol / chunks);
    }
    paintBand(before);
    return n;
  }

  // Tops the fill readout up to `frac` (e.g. 0.95) by pouring the shortfall
  // straight into the bottom pile. Returns guys added (0 if already there).
  // s4 tower-fill: the readout is tower HEIGHT now, so chase the fraction in
  // shrinking volume steps instead of computing one volumetric delta.
  function devFillTo(frac) {
    if (!glass) return 0;
    var added = 0;
    for (var round = 0; round < 40 && fillFraction() < frac; round++) {
      var gap = frac - fillFraction();
      added += devPourBottom(glass.capacity * Math.max(0.01, gap * 0.35));
    }
    return added;
  }

  // Where the pile surface is, for society actors.
  function surfaceAt(x) { var i = colAt(x); return bottomSurfY(i); }

  // Structures are PHANTOM SOLID: each displaces exactly its own body — sand
  // stacks against the walls, pours over the roof, and can bury the house
  // (that's the tragedy working as intended). Nothing above the roof is
  // blocked, and the sand under a foundation never drains away.
  function setObstacles(boxes) {
    if (!obstAdd) return;
    obstAdd.fill(0);
    obstMin.fill(0);
    obstacleBoxes = boxes || [];
    for (var b = 0; b < obstacleBoxes.length; b++) {
      var box = obstacleBoxes[b];
      var i0 = colAt(box.x0), i1 = colAt(box.x1);
      for (var i = i0; i <= i1; i++) {
        obstAdd[i] = Math.max(obstAdd[i], box.y1 - box.y0);
        obstMin[i] = Math.max(obstMin[i],
          Math.min(bottom.h[i], Math.max(0, floorY[i] - box.y1)));
      }
    }
  }

  // Underside of the top mass at x — where the doomed buildings hang from
  // while the inverted pile falls (js/society.js).
  function topBaseAt(x) { return topBase ? topBase[colAt(x)] : 0; }

  window.Pile = {
    init: init, groundAt: groundAt, bakeBody: bakeBody, flipToTop: flipToTop,
    drainStep: drainStep, render: render, serialize: serialize, restore: restore,
    captureRise: captureRise, commitRise: commitRise, settleTick: settleTick,
    setObstacles: setObstacles,
    get obstacleBoxes() { return obstacleBoxes; },
    resynthesize: resynthesize, fillFraction: fillFraction, surfaceAt: surfaceAt,
    devFillTo: devFillTo,
    pourTop: pourTop, relaxBottom: relaxBottom, addBottomVolume: addBottomVolume,
    crushTick: crushTick, crushFinish: crushEnd,
    topBaseAt: topBaseAt, bulkConvert: bulkConvert,
    paintBand: paintBand, volOfBody: volOfBody,
    get crushing() { return !!crush; },
    get atomizing() { return atom.active; },
    get atomRate() { return atom.active ? atom.rate : 0; },
    get topCredit() { return topCredit(); },
    bottom: bottom, top: top,
    get glassRef() { return glass; },
    get colWRef() { return colW; }
  };
})();
