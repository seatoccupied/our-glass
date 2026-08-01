/* The one glass, forever. Geometry + rendering. Global: Glass
   Local frame: origin at glass center, +y down. The glass grows per era;
   sandmen stay the same size — that's the whole perspective trick. */
(function () {
  'use strict';

  // Build the interior half-width profile top→bottom as [{y, hw}].
  // Each chamber meets its wood cap FLUSH at full width (flat floor/ceiling,
  // square corners) — no taper pockets. The throat curve (bell sweep from the
  // full-width bulb down to the neck) is the only place the wall leans in,
  // and the whole profile is built once on the top half then mirrored, so the
  // top chamber and bottom chamber are always exact reflections of each other.
  function buildProfile(H, bulbHW, neckHW, neckLen) {
    var pts = [];
    var top = -H / 2;
    function add(f, hw) { pts.push({ y: top + f * H, hw: hw }); }
    function easeRange(f0, f1, hw0, hw1, steps) {
      for (var i = 1; i <= steps; i++) {
        var t = i / steps;
        var e = (1 - Math.cos(Math.PI * t)) / 2; // cosine ease
        add(f0 + (f1 - f0) * t, hw0 + (hw1 - hw0) * e);
      }
    }
    var nl = (neckLen / H) / 2;              // neck half-length as fraction of H
    var halfSpan = 0.5 - nl;                 // f-span from cap (f=0) to neck edge
    // ✏️ TUNE: how much of each half-bulb (cap -> neck) stays a flat, full-width
    // wall before the throat curve sweeps in. 0 = curve starts right at the cap
    // (fully bell-shaped); closer to 1 = boxier glass with a short swoop.
    var straightF = CONFIG.BULB_STRAIGHT_FRAC * halfSpan;

    // top half: flat cap -> (optional straight wall) -> throat curve -> neck
    add(0, bulbHW);                                     // top cap, flush full width
    if (straightF > 0.0005) add(straightF, bulbHW);      // straight wall down to the curve
    easeRange(straightF, halfSpan, bulbHW, neckHW, 9);   // throat curve sweeping to the neck
    add(0.5 + nl, neckHW);                               // neck straight section

    // bottom half: exact mirror of the top (cosine ease is antisymmetric:
    // e(1-t) === 1-e(t), so this reflects the top curve point-for-point)
    easeRange(0.5 + nl, 1 - straightF, neckHW, bulbHW, 9); // mirrored throat curve
    add(1, bulbHW);                                        // bottom cap, flush full width
    return pts;
  }

  function hwAtFactory(profile) {
    return function (y) {
      var p = profile;
      if (y <= p[0].y) return p[0].hw;
      for (var i = 1; i < p.length; i++) {
        if (y <= p[i].y) {
          var t = (y - p[i - 1].y) / (p[i].y - p[i - 1].y || 1e-9);
          return p[i - 1].hw + (p[i].hw - p[i - 1].hw) * t;
        }
      }
      return p[p.length - 1].hw;
    };
  }

  function build(era, neckMult) {
    var C = CONFIG;
    var s = Math.pow(C.GROWTH, era - 1);
    var H = C.GLASS_H0 * s;
    var W = C.GLASS_W0 * s;
    var bulbHW = W / 2;
    var neckHW = Math.min(
      C.NECK_HW0 * Math.pow(C.NECK_GROWTH, era - 1) * (neckMult || 1),
      bulbHW * C.NECK_HW_MAX_FRAC);
    var neckLen = H * C.NECK_LEN_FRAC;
    var profile = buildProfile(H, bulbHW, neckHW, neckLen);
    var hwAt = hwAtFactory(profile);

    var neckTopY = -neckLen / 2, neckBottomY = neckLen / 2;
    var floorY = H / 2;

    // Wall segments for physics (both sides) + floor.
    var segs = [];
    for (var i = 1; i < profile.length; i++) {
      var a = profile[i - 1], b = profile[i];
      segs.push({ x1: a.hw, y1: a.y, x2: b.hw, y2: b.y });     // right wall
      segs.push({ x1: -a.hw, y1: a.y, x2: -b.hw, y2: b.y });   // left wall
    }
    var lastHW = profile[profile.length - 1].hw;
    segs.push({ x1: -lastHW, y1: floorY, x2: lastHW, y2: floorY }); // floor

    // Chamber areas by strip integration.
    function areaBetween(y0, y1) {
      var n = 60, sum = 0, dy = (y1 - y0) / n;
      for (var k = 0; k < n; k++) sum += 2 * hwAt(y0 + (k + 0.5) * dy) * dy;
      return sum;
    }
    var bottomArea = areaBetween(neckBottomY, floorY);
    var topArea = areaBetween(-H / 2, neckTopY);
    var capacity = bottomArea * C.FILL_FRAC;

    // lowerFloorY(x): where a dropped grain finally rests on bare glass in the
    // bottom chamber (the deepest y whose interior still spans |x|).
    function lowerFloorY(x) {
      var ax = Math.abs(x);
      if (ax >= bulbHW) return neckBottomY; // outside — shouldn't happen
      // walk profile from the bottom upward
      for (var i = profile.length - 1; i >= 1; i--) {
        var a = profile[i], b = profile[i - 1]; // a below b
        if (a.y <= neckBottomY) break;
        if (ax <= a.hw) return Math.min(a.y, floorY);
        if (ax <= b.hw) { // crosses between b and a
          var t = (ax - a.hw) / (b.hw - a.hw || 1e-9);
          return a.y + (b.y - a.y) * t;
        }
      }
      return neckBottomY;
    }

    // upperFloorY(x): the funnel floor of the TOP chamber (taper toward neck),
    // where the flipped mountain rests. Only defined for |x| >= neckHW*0.999;
    // inside that is the hole.
    function upperFloorY(x) {
      var ax = Math.abs(x);
      if (ax >= bulbHW) return -H / 2;
      for (var i = 0; i < profile.length - 1; i++) {
        var a = profile[i], b = profile[i + 1]; // a above b
        if (b.y > neckTopY + 1e-6) break;
        if (a.hw >= ax && b.hw <= ax) {
          var t = (a.hw - ax) / (a.hw - b.hw || 1e-9);
          return a.y + (b.y - a.y) * t;
        }
      }
      return neckTopY;
    }

    var glass = {
      era: era, s: s, H: H, W: W,
      bulbHW: bulbHW, neckHW: neckHW,
      neckTopY: neckTopY, neckBottomY: neckBottomY,
      rimY: -H / 2, rimHW: profile[0].hw, floorY: floorY,
      profile: profile, hwAt: hwAt, segs: segs,
      bottomArea: bottomArea, topArea: topArea, capacity: capacity,
      lowerFloorY: lowerFloorY, upperFloorY: upperFloorY,
      thickness: Math.max(7, 6 * Math.pow(s, 0.55))
    };
    return glass;
  }

  // ---------- rendering ----------

  function tracePath(ctx, glass, out) {
    // out: outward offset (glass thickness) for the outer silhouette
    var p = glass.profile, i;
    ctx.beginPath();
    ctx.moveTo(p[0].hw + out, p[0].y - (out ? out * 0.7 : 0));
    for (i = 1; i < p.length; i++) ctx.lineTo(p[i].hw + out, p[i].y);
    ctx.lineTo(-p[p.length - 1].hw - out, p[p.length - 1].y);
    for (i = p.length - 1; i >= 0; i--) ctx.lineTo(-p[i].hw - out, p[i].y);
    ctx.closePath();
  }

  // Draw everything BEHIND the world-inside-the-glass.
  function drawBack(ctx, glass) {
    var t = glass.thickness;
    // warm glow — the little world is the light source
    var g = ctx.createRadialGradient(0, glass.H * 0.28, glass.W * 0.1,
                                     0, glass.H * 0.18, glass.H * 0.85);
    g.addColorStop(0, 'rgba(255,190,110,0.16)');
    g.addColorStop(0.5, 'rgba(255,170,90,0.05)');
    g.addColorStop(1, 'rgba(255,170,90,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-glass.W, -glass.H * 0.75, glass.W * 2, glass.H * 1.8);

    // glass body (outer silhouette), faint cool fill
    tracePath(ctx, glass, t);
    ctx.fillStyle = 'rgba(150,190,255,0.07)';
    ctx.fill();

    // interior backdrop — a hint of depth
    tracePath(ctx, glass, 0);
    ctx.fillStyle = 'rgba(10,16,34,0.55)';
    ctx.fill();
  }

  // Draw everything IN FRONT of the world (outlines, shine, frame).
  function drawFront(ctx, glass) {
    var t = glass.thickness, H = glass.H, W = glass.W;

    // chunky ink outline — outer then inner
    tracePath(ctx, glass, t);
    ctx.lineWidth = Math.max(3, t * 0.5);
    ctx.strokeStyle = '#1a2340';
    ctx.stroke();
    tracePath(ctx, glass, 0);
    ctx.lineWidth = Math.max(2.5, t * 0.38);
    ctx.strokeStyle = 'rgba(210,228,255,0.5)';
    ctx.stroke();

    // shine streaks on the top-left of each bulb
    ctx.save();
    tracePath(ctx, glass, 0);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.055)';
    ctx.save();
    ctx.rotate(-0.32);
    var sw = W * 0.075;
    ctx.fillRect(-W * 0.43, -H * 0.62, sw, H * 0.5);
    ctx.fillRect(-W * 0.43 + sw * 1.8, -H * 0.62, sw * 0.45, H * 0.44);
    ctx.fillRect(-W * 0.5, -H * 0.02, sw, H * 0.52);
    ctx.fillRect(-W * 0.5 + sw * 1.8, 0, sw * 0.45, H * 0.46);
    ctx.restore();
    ctx.restore();

    // wooden frame: caps + pillars — cel style
    var capH = Math.max(14, H * 0.045);
    var capW = W * 1.18;
    var px = W * 0.565;                       // pillar center x
    var pw = Math.max(8, W * 0.035);          // pillar width
    ctx.lineWidth = Math.max(3, capH * 0.16);
    ctx.strokeStyle = '#241507';
    ctx.fillStyle = '#5b3a26';
    // pillars first (behind caps)
    roundRect(ctx, px - pw / 2, -H / 2 - capH * 0.4, pw, H + capH * 0.8, pw * 0.4);
    ctx.fill(); ctx.stroke();
    roundRect(ctx, -px - pw / 2, -H / 2 - capH * 0.4, pw, H + capH * 0.8, pw * 0.4);
    ctx.fill(); ctx.stroke();
    // caps
    ctx.fillStyle = '#6b4530';
    roundRect(ctx, -capW / 2, -H / 2 - capH, capW, capH, capH * 0.35);
    ctx.fill(); ctx.stroke();
    roundRect(ctx, -capW / 2, H / 2, capW, capH, capH * 0.35);
    ctx.fill(); ctx.stroke();
    // cap highlights
    ctx.fillStyle = 'rgba(255,214,160,0.18)';
    roundRect(ctx, -capW / 2 + capH * 0.3, -H / 2 - capH + capH * 0.18, capW - capH * 0.6, capH * 0.22, capH * 0.11);
    ctx.fill();
    roundRect(ctx, -capW / 2 + capH * 0.3, H / 2 + capH * 0.18, capW - capH * 0.6, capH * 0.22, capH * 0.11);
    ctx.fill();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  window.Glass = { build: build, drawBack: drawBack, drawFront: drawFront,
                   tracePath: tracePath, roundRect: roundRect };
})();
