/* Boot + game loop + camera + night sky. Global: Main */
(function () {
  'use strict';

  var canvas, ctx, DPR = 1, CW = 0, CH = 0; // CSS px
  var glass = null;
  var camera = { user: 1, panX: 0, panY: 0 };
  var spawnAcc = 0, saveAcc = 0, uiAcc = 0, gameT = 0;
  var shakeT = 0, shakeMag = 0;
  var dragging = false, dragX = 0, dragY = 0, didDrag = false;
  var lastTS = 0, acc = 0;
  var hintEl = null, hintIcon = null, hintPopup = null;
  var HINT_TEXT = 'scroll to zoom in on the little guys · drag to pan · double-click to reset';

  // ---------- camera ----------

  function panelRight() {
    var p = document.getElementById('panel');
    return p ? p.getBoundingClientRect().right + 10 : 430;
  }
  function viewCenter() {
    return { x: (panelRight() + CW) / 2, y: CH / 2 };
  }
  function fitZoomFor(g) {
    var availW = Math.max(200, CW - panelRight() - 30);
    var availH = Math.max(200, CH - 40);
    return Math.min(availW / (g.W * 1.42), availH / (g.H * 1.22));
  }
  function currentZoom() {
    var a = Flip.animState();
    if (a) {
      // the rotation plays at the OLD scale (zoomMix 0); the glass grows around
      // them during the crush that follows
      return U.lerp(fitZoomFor(a.oldGlass), fitZoomFor(a.newGlass), a.zoomMix);
    }
    return fitZoomFor(glass) * camera.user;
  }

  // ---------- night sky ----------
  // Layers, back to front, all screen-space unless noted:
  //   skyBase       fixed gradient + dune silhouette (never rotates)
  //   star wheel    stars + constellations, rotated by ONE transform around an
  //                 off-center pole. NOT a baked oversized canvas blit (that
  //                 was the first design — measured 27ms/frame at 2560x1440
  //                 under SwiftShader, ~240x the ~0.11ms baseline, because
  //                 rotate+drawImage of a multi-megapixel source is pathologically
  //                 slow in software rendering). Instead: stars are precomputed
  //                 wheel-local points, batched into a handful of (color,alpha)
  //                 groups so the whole field costs a dozen-ish fill() calls,
  //                 not hundreds — this is the "batched point stars" fallback
  //                 the brief pre-approved, and it measures ~0.03ms/frame added.
  //   moon          independent ~5 min rise/set arc, pre-rendered sprite so the
  //                 per-frame cost is a single small drawImage
  //   dust          ~30 near-depth motes, individually drifting (cheap arcs)
  //   shooting      occasional streak(s); a flurry fires on return from a long away
  //   vignette      fixed radial darken, unchanged from s1

  var STAR_REV_SECONDS = 3600;    // ✏️ TUNE: 1 full sky revolution per real hour
  var POLE_X_FRAC = 0.50;         // ✏️ TUNE: pole position across the game area (right of panel)
  var POLE_Y_FRAC = 0.40;         // ✏️ TUNE: pole height (0=top edge, 1=bottom edge) — "up/away" from the glass
  var MOON_ARC_SECONDS = 300;     // ✏️ TUNE: one full rise-to-set loop
  var SHOOT_MIN = 45, SHOOT_MAX = 120; // ✏️ TUNE: seconds between shooting stars
  var DUST_COUNT = 30;            // ✏️ TUNE: near-depth dust motes

  var skyBase = null;                       // fixed gradient + dunes
  var starWheelR = 0, poleX = 0, poleY = 0; // rotating field geometry
  var starGroups = [];              // static stars batched by (color,alpha) — a dozen fill() calls, not hundreds
  var twinklyStars = [];            // small set (9), individually animated
  var constellationInstances = [];  // flattened {cx,cy,s,pts,link}, rebuilt with buildStarWheel
  var moonSprite = null, moonSpriteR = 0, moonPhase = 0;      // 0..7, one step per flip
  var vignette = null;
  var dust = [];
  var shootingStars = [], shootAcc = 0;
  var shootNext = SHOOT_MIN + Math.random() * (SHOOT_MAX - SHOOT_MIN);

  // hand-placed constellation pool (8-10, always present, distributed around
  // the wheel — rotation carries them into/out of view). Point sets are
  // small unitless shapes drawn at cx,cy scaled by s; link = edge index pairs.
  var BASE_CONSTELLATIONS = (function () {
    var LITTLE_GUY = { // the original quiet joke, kept as one entry in the pool
      pts: [[0, -1.6], [-0.7, -1.1], [0.7, -1.1], [0, -0.8], [0, 0.2],
            [-0.9, -0.4], [0.9, -0.4], [-0.5, 1.2], [0.5, 1.2]],
      link: [[0, 3], [3, 5], [3, 6], [3, 4], [4, 7], [4, 8], [0, 1], [0, 2]]
    };
    var HOURGLASS = {
      pts: [[-0.7, -1], [0.7, -1], [0, 0], [-0.7, 1], [0.7, 1]],
      link: [[0, 1], [0, 2], [1, 2], [2, 3], [2, 4], [3, 4]]
    };
    var HUT = { // era 2, The Age of Huts
      pts: [[-0.8, 0.6], [0.8, 0.6], [-0.8, -0.3], [0.8, -0.3], [0, -1.1]],
      link: [[0, 1], [0, 2], [1, 3], [2, 4], [3, 4]]
    };
    var FUNNEL = { // era 3, The Wide Throat
      pts: [[-1, -1], [1, -1], [0, 1]],
      link: [[0, 1], [0, 2], [1, 2]]
    };
    var PYRAMID = { // era 4, The Age of Pyramids
      pts: [[-1, 0.7], [1, 0.7], [0, -1], [-0.5, 0.2], [0.5, 0.2]],
      link: [[0, 1], [0, 2], [1, 2], [3, 4]]
    };
    var LUTE = { // era 5, The Singing Era
      pts: [[-0.4, 0.3], [0.4, 0.3], [0, 1], [0.1, -1], [0.15, -1.3]],
      link: [[0, 1], [0, 2], [1, 2], [0, 3], [3, 4]]
    };
    var CROWN = { // era 6, The Golden Age
      pts: [[-1, 0.6], [-0.5, -0.7], [0, 0.6], [0.5, -0.7], [1, 0.6]],
      link: [[0, 1], [1, 2], [2, 3], [3, 4], [0, 4]]
    };
    var RIVER = {
      pts: [[-1, 0], [-0.5, -0.4], [0, 0.2], [0.5, -0.4], [1, 0]],
      link: [[0, 1], [1, 2], [2, 3], [3, 4]]
    };
    var MOUNTAINS = {
      pts: [[-1, 0.7], [-0.55, -0.9], [-0.1, 0.1], [0.5, -0.6], [1, 0.7]],
      link: [[0, 1], [1, 2], [2, 3], [3, 4]]
    };
    var shapes = [LITTLE_GUY, HOURGLASS, HUT, FUNNEL, PYRAMID, LUTE, CROWN, RIVER, MOUNTAINS];
    var rng = U.rng(555);
    var out = [];
    for (var i = 0; i < shapes.length; i++) {
      out.push({
        angle: (i / shapes.length) * U.TAU + rng() * 0.35,
        rFrac: 0.38 + rng() * 0.5,
        scale: 0.85 + rng() * 0.4,
        pts: shapes[i].pts, link: shapes[i].link
      });
    }
    return out;
  })();

  // one MORE constellation per era, cumulative — "the civilization writing
  // itself into the sky." Beyond the hand-placed pool above, these are small
  // procedural clusters seeded by era index so they're stable across reloads.
  var eraConstellations = [];
  function proceduralConstellation(seed) {
    var rng = U.rng(seed * 7919 + 13);
    var n = 4 + Math.floor(rng() * 3);
    var pts = [];
    for (var i = 0; i < n; i++) {
      var a = rng() * U.TAU, r = 0.3 + rng() * 0.9;
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    var link = [];
    for (var j = 1; j < n; j++) link.push([j - 1, j]);
    if (rng() < 0.5) link.push([n - 1, 0]);
    return { pts: pts, link: link };
  }
  function growEraConstellations() {
    var want = Math.max(0, Econ.era - 1);
    while (eraConstellations.length < want) {
      var idx = eraConstellations.length + 1;
      var shape = proceduralConstellation(idx);
      var rng = U.rng(idx * 104729 + 5);
      eraConstellations.push({
        angle: rng() * U.TAU, rFrac: 0.28 + rng() * 0.6,
        scale: 0.8 + rng() * 0.5, pts: shape.pts, link: shape.link
      });
    }
  }

  // every constellation shares the SAME stroke/fill style, so all of them —
  // base pool + era-added, easily 15-20 by the late game — draw in exactly
  // TWO calls (one stroke for every line, one fill for every dot) instead of
  // two per constellation. Softare-rasterizer draw-call overhead (SwiftShader)
  // is the dominant cost at this scale, not path complexity, so this matters.
  function drawConstellations(c, list) {
    var inst, l, p;
    c.strokeStyle = 'rgba(188,208,255,0.10)';
    c.lineWidth = 1;
    c.beginPath();
    for (var i = 0; i < list.length; i++) {
      inst = list[i];
      for (l = 0; l < inst.link.length; l++) {
        c.moveTo(inst.cx + inst.pts[inst.link[l][0]][0] * inst.s, inst.cy + inst.pts[inst.link[l][0]][1] * inst.s);
        c.lineTo(inst.cx + inst.pts[inst.link[l][1]][0] * inst.s, inst.cy + inst.pts[inst.link[l][1]][1] * inst.s);
      }
    }
    c.stroke();
    c.fillStyle = 'rgba(210,225,255,0.5)';
    c.beginPath();
    for (var j = 0; j < list.length; j++) {
      inst = list[j];
      for (p = 0; p < inst.pts.length; p++) {
        var px = inst.cx + inst.pts[p][0] * inst.s, py = inst.cy + inst.pts[p][1] * inst.s;
        c.moveTo(px + 1.3, py);
        c.arc(px, py, 1.3, 0, U.TAU);
      }
    }
    c.fill();
  }

  function buildSkyBase() {
    skyBase = document.createElement('canvas');
    skyBase.width = Math.ceil(CW * DPR);
    skyBase.height = Math.ceil(CH * DPR);
    var c = skyBase.getContext('2d');
    c.scale(DPR, DPR);
    var grad = c.createLinearGradient(0, 0, 0, CH);
    grad.addColorStop(0, '#04060d');
    grad.addColorStop(0.6, '#070b16');
    grad.addColorStop(1, '#0a1020');
    c.fillStyle = grad;
    c.fillRect(0, 0, CW, CH);
    // (s4: dune silhouettes removed — full night sky, the hourglass floats.
    // The rotating stars used to pass "through" the fixed dunes and looked
    // janky at ground level.)
  }

  function buildVignette() {
    vignette = document.createElement('canvas');
    vignette.width = Math.ceil(CW * DPR);
    vignette.height = Math.ceil(CH * DPR);
    var v = vignette.getContext('2d');
    v.scale(DPR, DPR);
    var vg = v.createRadialGradient(CW / 2, CH / 2, Math.min(CW, CH) * 0.45,
                                    CW / 2, CH / 2, Math.max(CW, CH) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.45)');
    v.fillStyle = vg;
    v.fillRect(0, 0, CW, CH);
  }

  // Star field geometry: points scattered in a disk of radius starWheelR
  // around an off-center pole, wide enough to circumscribe the viewport at
  // ANY rotation angle (so the slow 1-rev/hour turn never reveals a gap).
  // Stars are batched into a handful of (color, alpha-bucket) groups so the
  // whole field draws in a dozen-ish fill() calls per frame, not hundreds —
  // this replaced an earlier design that baked everything into one oversized
  // canvas and rotated it as a single drawImage; that measured 27ms/frame at
  // 2560x1440 under SwiftShader (~240x the ~0.11ms baseline) because rotating
  // a multi-megapixel source is pathologically slow in software rendering.
  function buildStarWheel() {
    poleX = panelRight() + (CW - panelRight()) * POLE_X_FRAC;
    poleY = CH * POLE_Y_FRAC;
    var corners = [[0, 0], [CW, 0], [0, CH], [CW, CH]];
    var maxD = 0;
    for (var i = 0; i < 4; i++) {
      var ddx = corners[i][0] - poleX, ddy = corners[i][1] - poleY;
      var d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d > maxD) maxD = d;
    }
    starWheelR = Math.min(maxD + 24, 2600); // safety cap for extreme viewports

    var rng = U.rng(777);
    var refArea = Math.max(1, CW * CH);
    var diskArea = Math.PI * starWheelR * starWheelR;
    var starCount = Math.round(130 * (diskArea / refArea));
    var ALPHA_STEPS = 5; // coarser buckets = fewer fill() calls; invisible at this size

    var buckets = {}; // "colorIdx_alphaStep" -> {hex, alpha, pts:[[bx,by,r],...]}
    twinklyStars = [];
    for (var i = 0; i < starCount; i++) {
      // uniform point in a disk: sqrt(rng()) for uniform area density
      var ang = rng() * U.TAU, rad = Math.sqrt(rng()) * starWheelR;
      var bx = Math.cos(ang) * rad, by = Math.sin(ang) * rad;
      var r = 0.4 + rng() * 1.5;
      var a = 0.2 + rng() * 0.55;
      var colorIdx = rng() < 0.25 ? 0 : 1;
      if (i < 9) { // first 9 are the animated twinkles, drawn separately
        twinklyStars.push({ bx: bx, by: by, r: r + 0.7, ph: rng() * 6 });
        continue;
      }
      var step = Math.round(a * ALPHA_STEPS);
      var key = colorIdx + '_' + step;
      if (!buckets[key]) {
        buckets[key] = { hex: colorIdx === 0 ? '#bcd0ff' : '#e8edfa', alpha: step / ALPHA_STEPS, pts: [] };
      }
      buckets[key].pts.push([bx, by, r]);
    }
    starGroups = [];
    for (var k in buckets) starGroups.push(buckets[k]);

    constellationInstances = [];
    for (var b = 0; b < BASE_CONSTELLATIONS.length; b++) {
      var bc = BASE_CONSTELLATIONS[b];
      constellationInstances.push({
        cx: Math.cos(bc.angle) * bc.rFrac * starWheelR,
        cy: Math.sin(bc.angle) * bc.rFrac * starWheelR,
        s: starWheelR * 0.05 * bc.scale, pts: bc.pts, link: bc.link
      });
    }
    for (var e = 0; e < eraConstellations.length; e++) {
      var ec = eraConstellations[e];
      constellationInstances.push({
        cx: Math.cos(ec.angle) * ec.rFrac * starWheelR,
        cy: Math.sin(ec.angle) * ec.rFrac * starWheelR,
        s: starWheelR * 0.045 * ec.scale, pts: ec.pts, link: ec.link
      });
    }
  }

  // pre-rendered so the per-frame cost of the moving moon is one small blit.
  // Rebuilt on resize and whenever the phase advances (once per flip).
  function buildMoonSprite() {
    var mr = Math.min(CW, CH) * 0.035;
    var haloR = mr * 1.9; // was 2.4 with a hard edge — reads as a button; softened below
    moonSpriteR = haloR;
    var size = Math.ceil(haloR * 2);
    moonSprite = document.createElement('canvas');
    moonSprite.width = Math.ceil(size * DPR);
    moonSprite.height = Math.ceil(size * DPR);
    var c = moonSprite.getContext('2d');
    c.scale(DPR, DPR);
    var cx = haloR, cy = haloR;

    // soft halo: true radial falloff, no hard edge (the earlier flat-alpha
    // disc is what made it read as a button)
    var g = c.createRadialGradient(cx, cy, mr * 0.7, cx, cy, haloR);
    g.addColorStop(0, 'rgba(217,222,240,0.10)');
    g.addColorStop(1, 'rgba(217,222,240,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(cx, cy, haloR, 0, U.TAU); c.fill();

    // phase: 8 steps per cycle, one per flip. ts 0 = new, 0.5 = full; +0.25
    // starts era 1 on a friendly waxing half instead of an invisible new moon.
    // s4 (Zach): REAL phase geometry — lit region = limb semicircle +
    // elliptical terminator over a dim earthshine disc (the old punched
    // circle read as "a black dot on a full moon") — and the man in the moon
    // is one of the little guys, his face keyed to the phase: wide awake at
    // full, easy smile at half/gibbous, drowsy at crescent, asleep at new.
    var t = (((moonPhase % 8) + 8) % 8) / 8;
    var ts = (t + 0.25) % 1;
    var f = (1 - Math.cos(U.TAU * ts)) / 2;   // lit fraction: 0 new .. 1 full
    var waxing = ts < 0.5;

    // earthshine: the unlit moon is a barely-there disc, not a hole in the sky
    c.fillStyle = '#161d33';
    c.beginPath(); c.arc(cx, cy, mr, 0, U.TAU); c.fill();

    // lit region, drawn waxing (lit limb on the right); the whole face-lit
    // moon mirrors horizontally when waning, face included.
    c.save();
    c.translate(cx, cy);
    if (!waxing) c.scale(-1, 1);
    var k = 2 * f - 1;              // terminator bow: -1 crescent .. +1 full
    var rx = Math.abs(k) * mr;
    function litPath() {
      c.beginPath();
      c.arc(0, 0, mr, -Math.PI / 2, Math.PI / 2, false);  // down the lit limb
      if (k >= 0) c.ellipse(0, 0, rx, mr, 0, Math.PI / 2, Math.PI * 1.5, false); // gibbous: bow into the dark
      else        c.ellipse(0, 0, rx, mr, 0, Math.PI / 2, -Math.PI / 2, true);   // crescent: bow into the light
      c.closePath();
    }
    if (f > 0.02) {
      litPath();
      c.fillStyle = '#d9def0';
      c.fill();
    }

    // The man in the moon is one of the little guys. His face lives ONLY in
    // the lit part (clipped to it, centred in it, shrunk to fit a crescent
    // sliver), and every phase gets its own silly expression (Zach, s4).
    // step: 0 half-wax · 1 gibbous-wax · 2 FULL · 3 gibbous-wane ·
    //       4 half-wane · 5 crescent-wane · 6 new (faceless) · 7 crescent-wax
    if (f > 0.02) {
      var step = ((moonPhase % 8) + 8) % 8;
      var xTerm = -k * mr;                  // terminator x at the equator
      var fx = (xTerm + mr) / 2;            // middle of the light
      var s = Math.min(1, (mr - xTerm) / (0.9 * mr)); // fit the sliver
      litPath();
      c.save();
      c.clip();
      c.translate(fx, 0);
      c.scale(s, s);
      c.strokeStyle = '#252e52'; c.fillStyle = '#252e52';
      c.lineWidth = Math.max(1.5, mr * 0.1) / Math.max(0.45, s);
      c.lineCap = 'round';
      var ex = mr * 0.34, ey = -mr * 0.14, er = mr * 0.12;
      if (step === 0) {        // goofy tongue-out grin
        c.beginPath(); c.arc(-ex, ey, er, 0, U.TAU); c.fill();
        c.beginPath(); c.arc(ex, ey, er, 0, U.TAU); c.fill();
        c.beginPath(); c.arc(0, mr * 0.18, mr * 0.3, 0, Math.PI, false); c.stroke();
        c.beginPath(); c.arc(mr * 0.13, mr * 0.5, mr * 0.14, 0, U.TAU); c.fill();
      } else if (step === 1) { // cross-eyed derp + squiggle mouth
        c.beginPath(); c.arc(-ex, ey, er * 1.5, 0, U.TAU); c.stroke();
        c.beginPath(); c.arc(ex, ey, er * 1.5, 0, U.TAU); c.stroke();
        c.beginPath(); c.arc(-ex + er * 0.7, ey + er * 0.4, er * 0.55, 0, U.TAU); c.fill();
        c.beginPath(); c.arc(ex - er * 0.7, ey - er * 0.4, er * 0.55, 0, U.TAU); c.fill();
        c.beginPath();
        c.arc(-mr * 0.12, mr * 0.34, mr * 0.12, Math.PI, 0, true);
        c.arc(mr * 0.12, mr * 0.34, mr * 0.12, Math.PI, 0, false);
        c.stroke();
      } else if (step === 2) { // FULL: ecstatic — brows, huge eyes, open grin
        c.beginPath(); c.arc(-ex, ey, er * 1.4, 0, U.TAU); c.fill();
        c.beginPath(); c.arc(ex, ey, er * 1.4, 0, U.TAU); c.fill();
        c.beginPath(); c.arc(-ex, ey - er * 2.2, er * 1.5, Math.PI * 1.15, Math.PI * 1.85, false); c.stroke();
        c.beginPath(); c.arc(ex, ey - er * 2.2, er * 1.5, Math.PI * 1.15, Math.PI * 1.85, false); c.stroke();
        c.beginPath(); c.arc(0, mr * 0.2, mr * 0.36, Math.PI * 0.1, Math.PI * 0.9, false);
        c.closePath(); c.fill();
      } else if (step === 3) { // cheeky wink + smirk
        c.beginPath(); c.arc(-ex, ey, er * 1.15, 0, U.TAU); c.fill();
        c.beginPath(); c.arc(ex, ey, er * 1.15, Math.PI * 0.15, Math.PI * 0.85, false); c.stroke();
        c.beginPath(); c.arc(-mr * 0.05, mr * 0.42, mr * 0.22, Math.PI * 1.25, Math.PI * 1.95, true); c.stroke();
      } else if (step === 4) { // whistling: relaxed arc eyes + little o mouth
        c.beginPath(); c.arc(-ex, ey, er, Math.PI * 1.15, Math.PI * 1.85, false); c.stroke();
        c.beginPath(); c.arc(ex, ey, er, Math.PI * 1.15, Math.PI * 1.85, false); c.stroke();
        c.beginPath(); c.arc(mr * 0.06, mr * 0.34, mr * 0.1, 0, U.TAU); c.stroke();
      } else if (step === 5) { // zonked: half-lids + open drooly mouth
        c.beginPath(); c.moveTo(-ex - er, ey); c.lineTo(-ex + er, ey + er * 0.4); c.stroke();
        c.beginPath(); c.moveTo(ex - er, ey + er * 0.4); c.lineTo(ex + er, ey); c.stroke();
        c.beginPath(); c.arc(0, mr * 0.36, mr * 0.13, 0, U.TAU); c.fill();
        c.beginPath(); c.moveTo(mr * 0.1, mr * 0.46); c.lineTo(mr * 0.12, mr * 0.62); c.stroke();
      } else if (step === 7) { // peeking sliver: one huge surprised eye
        c.beginPath(); c.arc(0, ey, er * 1.9, 0, U.TAU); c.stroke();
        c.beginPath(); c.arc(0, ey, er * 0.8, 0, U.TAU); c.fill();
        c.beginPath(); c.arc(0, mr * 0.38, mr * 0.09, 0, U.TAU); c.stroke();
      }                        // step 6 = new moon: nothing lit, no face
      c.restore();
    }
    c.restore();
  }

  function initDust() {
    var rng = U.rng(4242);
    dust = [];
    for (var i = 0; i < DUST_COUNT; i++) {
      dust.push({
        x: rng() * CW, y0: rng() * CH,
        r: 0.6 + rng() * 1.1,
        fall: 4 + rng() * 8,      // px/s slow downward drift, wraps
        amp: 3 + rng() * 9,       // horizontal sway px
        sp: 0.15 + rng() * 0.25,  // sway speed
        ph: rng() * U.TAU,
        a: 0.06 + rng() * 0.12
      });
    }
  }

  function buildSky() {
    buildSkyBase();
    buildStarWheel();
    buildMoonSprite();
    buildVignette();
    initDust();
  }

  // reconciles moon phase + era-added constellations with the CURRENT era
  // (called once after a save loads, and again whenever the era changes)
  function syncSkyToEra() {
    moonPhase = Econ.era - 1;
    growEraConstellations();
    buildMoonSprite();
    buildStarWheel();
  }

  function spawnShootingStar(delay) {
    shootingStars.push({
      x: CW * (0.5 + Math.random() * 0.4), y: CH * 0.08,
      vx: -(300 + Math.random() * 300), vy: 160,
      life: 1.1, delay: delay || 0
    });
  }
  function spawnShootingFlurry() {
    var n = 5 + Math.floor(Math.random() * 4);
    for (var i = 0; i < n; i++) spawnShootingStar(Math.random() * 2.2);
  }

  // ---------- resize / input ----------

  function resize() {
    DPR = window.devicePixelRatio || 1;
    CW = window.innerWidth; CH = window.innerHeight;
    canvas.width = Math.ceil(CW * DPR);
    canvas.height = Math.ceil(CH * DPR);
    canvas.style.width = CW + 'px';
    canvas.style.height = CH + 'px';
    buildSky();
  }

  function maxUserZoom() {
    return Math.max(1.5, 70 / (CONFIG.R0 * fitZoomFor(glass)));
  }

  function wireInput() {
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (Flip.midFlip()) return;
      var vc = viewCenter();
      var z0 = fitZoomFor(glass) * camera.user;
      var factor = Math.pow(1.0015, -e.deltaY);
      camera.user = U.clamp(camera.user * factor, 1, maxUserZoom());
      var z1 = fitZoomFor(glass) * camera.user;
      // keep the world point under the cursor put
      var wx = (e.clientX - vc.x - camera.panX) / z0;
      var wy = (e.clientY - vc.y - camera.panY) / z0;
      camera.panX = e.clientX - vc.x - wx * z1;
      camera.panY = e.clientY - vc.y - wy * z1;
      if (camera.user === 1) { camera.panX = 0; camera.panY = 0; }
      clampPan();
      hideHint();
    }, { passive: false });

    canvas.addEventListener('mousedown', function (e) {
      dragging = true; didDrag = false;
      dragX = e.clientX; dragY = e.clientY;
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - dragX, dy = e.clientY - dragY;
      if (Math.abs(dx) + Math.abs(dy) > 3) didDrag = true;
      camera.panX += dx; camera.panY += dy;
      dragX = e.clientX; dragY = e.clientY;
      clampPan();
    });
    window.addEventListener('mouseup', function () { dragging = false; });
    canvas.addEventListener('dblclick', function () {
      camera.user = 1; camera.panX = 0; camera.panY = 0;
    });
    window.addEventListener('pointerdown', function () { Sound.unlock(); }, { once: false });
    window.addEventListener('keydown', function () { Sound.unlock(); });
  }

  function clampPan() {
    var z = fitZoomFor(glass) * camera.user;
    var lim = Math.max(glass.W, glass.H) * z * 0.75;
    camera.panX = U.clamp(camera.panX, -lim, lim);
    camera.panY = U.clamp(camera.panY, -lim, lim);
  }

  function hideHint() {
    if (hintEl) { hintEl.style.opacity = '0'; setTimeout(function () { if (hintEl) { hintEl.remove(); hintEl = null; } }, 600); }
  }

  // small persistent corner icon that re-shows the hint on hover, forever —
  // the old 45s-only hint permanently hid the game's best view (ROADMAP #17.4)
  function buildHintIcon() {
    hintIcon = document.createElement('div');
    hintIcon.textContent = '?';
    hintIcon.setAttribute('aria-label', 'view controls');
    hintIcon.style.cssText = 'position:fixed;right:24px;bottom:18px;width:24px;height:24px;' +
      'border-radius:50%;background:rgba(18,22,38,0.55);color:#7c88ad;font:700 13px/24px sans-serif;' +
      'text-align:center;cursor:default;z-index:20;user-select:none;' +
      'border:1px solid rgba(147,160,196,0.2);transition:opacity 0.4s;opacity:0;';
    hintPopup = document.createElement('div');
    hintPopup.textContent = HINT_TEXT;
    hintPopup.style.cssText = 'position:fixed;right:24px;bottom:50px;color:#93a0c4;' +
      'font-size:14px;font-weight:600;z-index:20;opacity:0;transition:opacity 0.25s;' +
      'pointer-events:none;white-space:nowrap;background:rgba(8,10,20,0.6);' +
      'padding:6px 10px;border-radius:6px;';
    document.body.appendChild(hintPopup);
    document.body.appendChild(hintIcon);
    hintIcon.addEventListener('mouseenter', function () { hintPopup.style.opacity = '0.95'; });
    hintIcon.addEventListener('mouseleave', function () { hintPopup.style.opacity = '0'; });
    setTimeout(function () { if (hintIcon) hintIcon.style.opacity = '1'; }, 50);
  }

  // ---------- era / glass management ----------

  function rebuildGlass() {
    // same era, new neck (Bottleneck Throttle) — keep the pile
    var snap = Pile.serialize();
    glass = Glass.build(Econ.era, Econ.neckMult());
    Pile.init(glass);
    Pile.restore(snap);
  }
  function rebuildGlassHard() {
    // era change from a save load — Pile.restore comes after
    glass = Glass.build(Econ.era, Econ.neckMult());
    Pile.init(glass);
  }
  function onEraChanged(newGlass) {
    glass = newGlass;
    resetCamera();
    moonPhase = (moonPhase + 1) % 8;
    growEraConstellations();
    buildMoonSprite();
    buildStarWheel();
  }
  function resetCamera() { camera.user = 1; camera.panX = 0; camera.panY = 0; }

  // ---------- update / render ----------

  function update(dt) {
    gameT += dt;
    Guys.tick(dt);
    // only the 180° rotation freezes the world; the crush that follows is a
    // real physical collapse and the sim has to be running for it
    if (!Flip.frozen()) {
      // s4: the rain pauses while the glass sits FULL — nothing tops up the
      // chamber while the world waits for the player's flip (no auto-flip)
      if (Flip.state !== 'FULL') {
        spawnAcc += dt;
        var interval = Econ.dropInterval();
        var burst = 0;
        while (spawnAcc >= interval && burst < 6) {
          spawnAcc -= interval;
          Guys.drop(Econ.dropCount(), glass);
          burst++;
        }
        if (spawnAcc > interval * 4) spawnAcc = 0;
      } else spawnAcc = 0;
      Phys.step(dt, glass, gameT);
      Pile.drainStep(dt, Econ.drainRate());
      Pile.settleTick(dt);
      Society.tick(dt);
      Econ.earnPassive(dt);
    }
    Flip.tick(dt);
    FX.step(dt);

    // occasional shooting star(s) — random interval SHOOT_MIN..SHOOT_MAX,
    // plus a flurry can be queued (return from a long away)
    shootAcc += dt;
    if (shootAcc > shootNext) {
      shootAcc = 0;
      shootNext = SHOOT_MIN + Math.random() * (SHOOT_MAX - SHOOT_MIN);
      spawnShootingStar(0);
    }
    for (var si = shootingStars.length - 1; si >= 0; si--) {
      var ss = shootingStars[si];
      if (ss.delay > 0) { ss.delay -= dt; continue; }
      ss.x += ss.vx * dt; ss.y += ss.vy * dt; ss.life -= dt;
      if (ss.life <= 0) shootingStars.splice(si, 1);
    }
    if (shakeT > 0) shakeT -= dt;
  }

  function render() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, CW, CH);
    ctx.drawImage(skyBase, 0, 0, CW, CH);

    // star wheel: one rotate transform, batched draws — see buildStarWheel's
    // header comment for why this isn't a baked-bitmap blit
    var theta = (gameT / STAR_REV_SECONDS) * U.TAU;
    ctx.save();
    ctx.translate(poleX, poleY);
    ctx.rotate(theta);
    for (var g = 0; g < starGroups.length; g++) {
      var grp = starGroups[g];
      ctx.fillStyle = grp.hex;
      ctx.globalAlpha = grp.alpha;
      ctx.beginPath();
      for (var pi = 0; pi < grp.pts.length; pi++) {
        var sp = grp.pts[pi];
        ctx.moveTo(sp[0] + sp[2], sp[1]);
        ctx.arc(sp[0], sp[1], sp[2], 0, U.TAU);
      }
      ctx.fill();
    }
    ctx.fillStyle = '#f4f7ff';
    for (var i = 0; i < twinklyStars.length; i++) {
      var t = twinklyStars[i];
      var driftX = Math.sin(gameT * 0.12 + t.ph) * 2.2;
      var driftY = Math.cos(gameT * 0.09 + t.ph * 1.3) * 1.6;
      ctx.globalAlpha = 0.3 + 0.5 * (Math.sin(gameT * 2 + t.ph) + 1) / 2;
      ctx.beginPath(); ctx.arc(t.bx + driftX, t.by + driftY, t.r, 0, U.TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
    drawConstellations(ctx, constellationInstances);
    ctx.restore();

    // moon: independent arc, rises one side / sets the other, on its own loop
    var mt = (gameT % MOON_ARC_SECONDS) / MOON_ARC_SECONDS;
    var moonX = U.lerp(-0.12 * CW, 1.12 * CW, mt);
    var moonY = CH * 0.86 - CH * 0.74 * Math.sin(Math.PI * mt);
    ctx.drawImage(moonSprite, moonX - moonSpriteR, moonY - moonSpriteR, moonSpriteR * 2, moonSpriteR * 2);

    // depth dust: nearest sky layer, drifting individually — one shared path
    // + one fill (a flat mid-alpha reads the same as per-mote alpha at this
    // size; each mote still drifts on its own phase/speed)
    ctx.globalAlpha = 0.11;
    ctx.fillStyle = '#dfe6ff';
    ctx.beginPath();
    for (var di = 0; di < dust.length; di++) {
      var d = dust[di];
      var dy = (d.y0 + gameT * d.fall) % CH;
      var dxp = d.x + Math.sin(gameT * d.sp + d.ph) * d.amp;
      ctx.moveTo(dxp + d.r, dy);
      ctx.arc(dxp, dy, d.r, 0, U.TAU);
    }
    ctx.fill();
    ctx.globalAlpha = 1;

    // shooting star(s)
    for (var sj = 0; sj < shootingStars.length; sj++) {
      var ss = shootingStars[sj];
      if (ss.delay > 0) continue;
      var sa = Math.min(1, ss.life * 2);
      var sgrad = ctx.createLinearGradient(ss.x, ss.y,
        ss.x - ss.vx * 0.25, ss.y - ss.vy * 0.25);
      sgrad.addColorStop(0, 'rgba(255,255,255,' + 0.8 * sa + ')');
      sgrad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = sgrad;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ss.x, ss.y);
      ctx.lineTo(ss.x - ss.vx * 0.25, ss.y - ss.vy * 0.25);
      ctx.stroke();
    }

    // world
    var vc = viewCenter();
    var z = currentZoom();
    var anim = Flip.animState();
    var sx = 0, sy = 0;
    if (shakeT > 0) {
      var m = shakeMag * shakeT * 10;
      sx = (Math.random() - 0.5) * m;
      sy = (Math.random() - 0.5) * m;
    }
    ctx.save();
    // the cinematic always plays centered — user pan/zoom sit it out
    ctx.translate(vc.x + (anim ? 0 : camera.panX) + sx,
                  vc.y + (anim ? 0 : camera.panY) + sy);
    ctx.scale(z, z);
    var gDraw = glass;
    if (anim) {
      // stage 0 turns the whole world — glass, piles, structures, live guys —
      // around the glass centre. The sidebar is HTML and stays put.
      if (anim.theta) ctx.rotate(anim.theta);
      gDraw = anim.glass;
    }
    Glass.drawBack(ctx, gDraw);
    // tension glow (ROADMAP #6): a SECOND, rising warm glow behind the pile
    // on top of glass.js's constant ambient one — reads Pile.fillFraction()
    // directly (canvas has no access to the CSS custom property js/ui.js
    // sets for the sidebar). Sits out the flip cinematic — the concept
    // doesn't apply mid-rotation/crush, and gDraw/glass can briefly disagree.
    if (!anim) {
      var fillNow = Pile.fillFraction();
      if (fillNow > 0.7) {
        var glowT = Math.min(1, (fillNow - 0.7) / 0.3);
        var glowGrad = ctx.createRadialGradient(0, gDraw.floorY, 0, 0, gDraw.floorY, gDraw.bulbHW * 1.7);
        glowGrad.addColorStop(0, 'rgba(255,130,60,' + (0.30 * glowT) + ')');
        glowGrad.addColorStop(1, 'rgba(255,130,60,0)');
        ctx.fillStyle = glowGrad;
        ctx.fillRect(-gDraw.W, gDraw.floorY - gDraw.H, gDraw.W * 2, gDraw.H * 2);
      }
    }
    Pile.render(ctx);
    Society.render(ctx, z);
    Guys.renderLive(ctx, z);
    FX.renderWorld(ctx, z);
    Glass.drawFront(ctx, gDraw);
    ctx.restore();

    FX.renderScreen(ctx);
    ctx.drawImage(vignette, 0, 0, CW, CH);
  }

  function loop(ts) {
    requestAnimationFrame(loop);
    if (!lastTS) lastTS = ts;
    var dt = Math.min(0.1, (ts - lastTS) / 1000);
    lastTS = ts;
    if (!window.__selftestDrive) {
      acc += dt;
      var steps = 0;
      while (acc >= CONFIG.DT && steps < 6) {
        update(CONFIG.DT);
        acc -= CONFIG.DT;
        steps++;
      }
      if (steps === 6) acc = 0; // fell behind — drop the debt, stay smooth
    }
    render();

    uiAcc += dt;
    if (uiAcc > 0.25) { uiAcc = 0; UI.refresh(); }
    saveAcc += dt;
    if (saveAcc > 30) { saveAcc = 0; Save.save(); }
  }

  function shake(mag) { shakeT = 0.5; shakeMag = mag * 10; }

  // ---------- away handling ----------

  var hiddenAt = 0;
  function wireVisibility() {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        hiddenAt = Date.now();
        Save.save();
      } else {
        lastTS = 0;
        var away = (Date.now() - hiddenAt) / 1000;
        if (away > 90 && !Flip.midFlip()) {
          var report = Save.processOffline({ t: hiddenAt }, Date.now());
          if (report && report.seconds > 300) { UI.showAway(report); spawnShootingFlurry(); }
          UI.refresh();
        }
      }
    });
    window.addEventListener('beforeunload', function () { Save.save(); });
  }

  // ---------- boot ----------

  function boot() {
    canvas = document.getElementById('game');
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', function () { resize(); });

    glass = Glass.build(1, 1);
    Pile.init(glass);

    // dev modes: ?selftest=1 (assert harness) and ?warp=N (fast-forward to era N).
    // Both drive their own ticks and must never touch real saves.
    var devMode = /[?&](selftest=1|warp=\d|perf=1)/.test(location.search);
    if (devMode) { window.__noSave = true; window.__selftestDrive = true; }
    // ?dev=1 alone (no warp/selftest/perf) shows the dev tools menu (js/ui.js)
    // over a fresh, live-playable sandbox game — it never loads OR saves over
    // the real save, so cheat buttons can't clobber real progress by accident.
    // It does NOT set __selftestDrive: the sim keeps ticking normally.
    var devFlag = devMode || /[?&]dev=1/.test(location.search);
    if (devFlag) window.__noSave = true;

    var data = devFlag ? null : Save.load();
    if (data) {
      Save.apply(data);
      var report = Save.processOffline(data);
      if (report) {
        setTimeout(function () { UI.showAway(report); }, 700);
        if (report.seconds > 300) spawnShootingFlurry();
      }
    }
    syncSkyToEra(); // moon phase + era constellations match whatever era we loaded into
    UI.init();
    wireInput();
    wireVisibility();
    Sound.setMuted(Save.muted);
    Sound.setVolumes(Save.volumes);

    buildHintIcon(); // persistent — the auto-hint below fades, this never does
    // gentle first-minute hint
    if (!data) {
      hintEl = document.createElement('div');
      hintEl.textContent = HINT_TEXT;
      hintEl.style.cssText = 'position:fixed;right:24px;bottom:52px;color:#93a0c4;' +
        'font-size:14px;font-weight:600;z-index:20;transition:opacity 0.6s;opacity:0.8;';
      document.body.appendChild(hintEl);
      setTimeout(hideHint, 45000);
    }

    requestAnimationFrame(loop);

    // dev harness (selftest / warp) loads only when asked
    if (devMode) {
      var s = document.createElement('script');
      s.src = 'test/selftest.js';
      document.body.appendChild(s);
    }
    // dev camera: ?zoom=N&fy=0.4 pre-aims the view (screenshot tooling)
    var zm = location.search.match(/[?&]zoom=([\d.]+)/);
    if (zm) {
      camera.user = U.clamp(parseFloat(zm[1]), 1, maxUserZoom());
      var fm = location.search.match(/[?&]fy=(-?[\d.]+)/);
      if (fm) camera.panY = -(glass.H * parseFloat(fm[1])) * fitZoomFor(glass) * camera.user;
    }
  }

  window.Main = { boot: boot, rebuildGlass: rebuildGlass,
                  rebuildGlassHard: rebuildGlassHard, onEraChanged: onEraChanged,
                  shake: shake, resetCamera: resetCamera,
                  glassRef: function () { return glass; },
                  update: update,   // exposed for the selftest
                  render: render,   // exposed for perf probing
                  // dev preview harness only (moon taste passes): bake the
                  // sprite at any phase and hand back a PNG data URL
                  _devMoonSprite: function (p) {
                    var keep = moonPhase;
                    moonPhase = ((p % 8) + 8) % 8;
                    buildMoonSprite();
                    var url = moonSprite.toDataURL('image/png');
                    moonPhase = keep;
                    buildMoonSprite();
                    return url;
                  },
                  get gameT() { return gameT; } };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else boot();
})();
