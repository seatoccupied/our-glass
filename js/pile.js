/* The pile system — population tiers 2 and 3.
   bottom: settled guys baked into a sprite canvas + collision heightfield.
   top:    the flipped mountain — volume + color histogram + heightfield,
           drawn as speckle mass, drained through the neck over time.
   Conservation: live + top.count + bottom.count === totalSpawned. Always. */
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

  // a big topple kicks up a visible grain rolling downhill (throttled)
  function grainAt(i, surfFn, dir) {
    if (!window.FX || !glass || FX.worldList.length > 60 || Math.random() < 0.5) return;
    var hist = surfFn === topSurfY ? top.hist : bottom.hist;
    var total = 0, k;
    for (k = 0; k < hist.length; k++) total += hist[k] || 0;
    var pick = 0;
    if (total > 0) {
      var rnd = Math.random() * total;
      for (k = 0; k < hist.length; k++) {
        rnd -= hist[k] || 0;
        if (rnd <= 0) { pick = k; break; }
      }
    }
    FX.grain(colX(i), surfFn(i) - CONFIG.R0 * 0.4, dir,
             PALETTE[pick] ? PALETTE[pick].hex : '#d9b877');
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
          if (t > colW * 0.5) grainAt(i + 1, bottomSurfY, 1);
        } else if (-diff > jit) {
          var t2 = (-diff - maxStep) * rate;
          var avail2 = bottom.h[i + 1] - obstMin[i + 1];
          if (avail2 < t2) t2 = Math.max(0, avail2);
          bottom.h[i + 1] -= t2; bottom.h[i] += t2; moved = moved || t2 > 0;
          if (t2 > colW * 0.5) grainAt(i, bottomSurfY, -1);
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

  function bakeBody(b) {
    var area = Math.PI * b.r * b.r;
    if (b.y < glass.neckTopY) {
      // became part of the mountain upstairs
      top.hist[b.colorIdx] = (top.hist[b.colorIdx] || 0) + 1;
      top.count++; top.volume += area;
      top.avgArea = top.volume / top.count;
      var ti = colAt(b.x);
      var roomT = (funnelBaseY(ti) - glass.rimY) - top.h[ti];
      if (area / colW <= roomT) top.h[ti] += area / colW;
      else topOverflow += area; // the chamber is full to the brim — bank it
      relaxTop();
      massPattern = null; // colors changed a bit
      // no payday on the mountain — the sand pays out down where it counts
      if (!b.earned) { top.unpaid++; b.earned = true; }
    } else {
      bottom.hist[b.colorIdx] = (bottom.hist[b.colorIdx] || 0) + 1;
      bottom.count++; bottom.volume += area;
      Guys.stampGuy(pileCtx, b);
      addBottomVolume(b.x, area);
      Econ.earnGuy(b);
    }
  }

  // ---------- the flip: bottom pile becomes the mountain ----------

  function flipToTop(newGlass) {
    var vol = bottom.volume, count = bottom.count;
    var hist = bottom.hist.slice();
    var carryTopVol = top.volume, carryTopCount = top.count; // usually 0
    var carryUnpaid = top.unpaid; // bottom guys are all paid; old debt carries
    for (var i = 0; i < top.hist.length; i++) hist[i] = (hist[i] || 0) + (top.hist[i] || 0);
    init(newGlass, false);
    top.volume = vol + carryTopVol;
    top.count = count + carryTopCount;
    top.unpaid = carryUnpaid;
    top.hist = hist;
    top.avgArea = top.count > 0 ? top.volume / top.count : Math.PI * 100;
    pourTop(top.volume);
  }

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

  function topSurfY(i) { return funnelBaseY(i) - top.h[i]; }

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
            if (t > colW * 0.5) grainAt(i + 1, topSurfY, 1);
          }
        } else if (-diff > jit) {
          var t2 = Math.min((-diff - maxStep) * rate, top.h[i + 1]);
          if (t2 > 0) {
            top.h[i + 1] -= t2; top.h[i] += t2; moved = true;
            if (t2 > colW * 0.5) grainAt(i, topSurfY, -1);
          }
        }
      }
      if (!moved) break;
    }
    // rim cap: no mountain ever pokes out of the glass. Excess goes to the
    // overflow bank; banked volume pours back the moment room opens up.
    var j, cap, room;
    for (j = 0; j < cols; j++) {
      cap = Math.max(0, funnelBaseY(j) - glass.rimY);
      if (top.h[j] > cap) { topOverflow += (top.h[j] - cap) * colW; top.h[j] = cap; }
    }
    if (topOverflow > 0) {
      for (j = 0; j < cols && topOverflow > 0; j++) {
        cap = Math.max(0, funnelBaseY(j) - glass.rimY);
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
    if (top.count <= 0) return;
    // a real hourglass backs up: when the mound under the neck has no headroom,
    // the flow pauses until avalanching spreads it. (Without this, the mound
    // slams into the chamber ceiling and guys stand on an invisible flare.)
    var ci0 = colAt(0);
    var centerSurf = Math.min(bottomSurfY(ci0),
                              bottomSurfY(Math.max(0, ci0 - 2)),
                              bottomSurfY(Math.min(cols - 1, ci0 + 2)));
    if (centerSurf - glass.neckBottomY < CONFIG.R0 * 4) {
      relaxBottom(0, cols - 1); // help the mound spread so flow can resume
      return;
    }
    // cap the backlog: after a stall the drain resumes as a stream, not a bomb
    drainAcc = Math.min(drainAcc + ratePerSec * dt, 30);
    var released = 0;
    while (drainAcc >= 1 && top.count > 0 && Phys.bodies.length < CONFIG.LIVE_CAP - 10) {
      drainAcc -= 1;
      releaseOne();
      released++;
      if (released > 8) break; // spread bursts across frames
    }
  }

  function releaseOne() {
    // pick a color proportionally from what's left up there
    var total = 0, i;
    for (i = 0; i < top.hist.length; i++) total += top.hist[i] || 0;
    var pick = 0;
    if (total > 0) {
      var rnd = Math.random() * total;
      for (i = 0; i < top.hist.length; i++) {
        rnd -= top.hist[i] || 0;
        if (rnd <= 0) { pick = i; break; }
      }
      top.hist[pick]--;
    }
    var area = top.avgArea;
    top.count--; top.volume = Math.max(0, top.volume - area);

    // remove material from the plug (center columns first)
    var need = area / colW, ci = colAt(0), k = 0;
    while (need > 0 && k < cols) {
      var j = ci + (k % 2 === 0 ? k / 2 : -(k + 1) / 2); // 0, +1, -1, +2, -2…
      k++;
      if (j < 0 || j >= cols) continue;
      var take = Math.min(top.h[j], need);
      top.h[j] -= take; need -= take;
    }
    if (need > 0 && topOverflow > 0) { // the shape ran dry; draw on the bank
      var fromBank = Math.min(need * colW, topOverflow);
      topOverflow -= fromBank;
    }
    relaxTop();

    // clamp: a corrupted volume/count ratio must never spawn kaiju sandmen
    var r = U.clamp(Math.sqrt(area / Math.PI), CONFIG.R0 * 0.55, CONFIG.R0 * 2.4);
    var owed = top.unpaid > 0;
    if (owed) top.unpaid--;
    Phys.spawn({
      x: (Math.random() - 0.5) * glass.neckHW * 0.8,
      y: glass.neckTopY + r * 1.2,
      vx: (Math.random() - 0.5) * 30, vy: 60,
      r: r, colorIdx: pick, earned: !owed
    });
    if (top.count === 0) { top.volume = 0; top.hist = []; }
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
  function drawGlints(ctx) {
    glintT += 1 / 60;
    var slot = Math.floor(glintT * 0.7);
    ctx.save();
    for (var k = 0; k < 14; k++) {
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
    for (i = 0; i < cols; i++) {
      if (top.h[i] > 0.5 || (!hole[i] && funnelY[i] > glass.rimY + 1)) {
        var sx = colX(i), sy = topSurfY(i);
        if (!started) { ctx.moveTo(sx, funnelBaseY(i)); ctx.lineTo(sx, sy); started = true; }
        else ctx.lineTo(sx, sy);
      }
    }
    for (i = cols - 1; i >= 0; i--) {
      if (top.h[i] > 0.5 || (!hole[i] && funnelY[i] > glass.rimY + 1)) {
        ctx.lineTo(colX(i), funnelBaseY(i));
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
      tcount: top.count, ov: Math.round(topOverflow), up: top.unpaid
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
    settleAcc += dt;
    if (settleAcc >= 0.5) {
      settleAcc = 0;
      relaxBottom(0, cols - 1);
      if (top.count > 0) relaxTop();
    }
  }

  function fillFraction() {
    if (!glass) return 0;
    // the living surface skin counts — those guys are part of the fill too
    var skin = 0, bs = window.Phys ? Phys.bodies : [];
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      if (b.settled && b.y >= glass.neckTopY) skin += Math.PI * b.r * b.r;
    }
    var v = bottom.volume + skin + (window.Society ? Society.structureVolume() : 0);
    return Math.min(1.25, v / glass.capacity);
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

  window.Pile = {
    init: init, groundAt: groundAt, bakeBody: bakeBody, flipToTop: flipToTop,
    drainStep: drainStep, render: render, serialize: serialize, restore: restore,
    captureRise: captureRise, commitRise: commitRise, settleTick: settleTick,
    setObstacles: setObstacles,
    get obstacleBoxes() { return obstacleBoxes; },
    resynthesize: resynthesize, fillFraction: fillFraction, surfaceAt: surfaceAt,
    pourTop: pourTop, relaxBottom: relaxBottom, addBottomVolume: addBottomVolume,
    bottom: bottom, top: top,
    get glassRef() { return glass; },
    get colWRef() { return colW; }
  };
})();
