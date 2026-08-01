/* Custom circle physics — one body per sandman, tuned for comedy not realism.
   Global: Phys. Settled guys get baked out by Pile (tier 2/3 of the perf plan). */
(function () {
  'use strict';

  var bodies = [];
  var lastNeckPassT = 0;   // game-time a guy last cleared the neck (anti-softlock)
  var curGlass = null;     // set each step; pair code needs the neck zone

  // the throat is polished glass — sand can't grip there, or it arches over
  // the opening and clogs the whole hourglass
  function frictionAt(y) {
    return curGlass && Math.abs(y) < curGlass.H * 0.14 ? 0.06 : 0.35;
  }

  function spawn(opts) {
    var b = {
      x: opts.x, y: opts.y,
      vx: opts.vx || 0, vy: opts.vy || 0,
      r: opts.r,
      angle: Math.random() * U.TAU,
      spin: (Math.random() - 0.5) * 6,
      colorIdx: opts.colorIdx,
      gold: !!opts.gold,
      face: opts.face != null ? opts.face : (Math.random() * 3) | 0,
      earned: !!opts.earned,      // true for drained re-entries (already paid)
      touch: 0,
      support: null,
      settled: false,             // scored and at rest — but still living sand
      sleeping: false,            // asleep in place: no sim cost, wakes on a bump
      aboveN: 0,                  // guys resting on top of me this frame
      coveredT: 0,                // how long I've been buried under the crowd
      driftT: 0, ax: opts.x, ay: opts.y, calm: 0, hadGround: false,
      jamT: 0,
      squash: 0,                  // squash-and-stretch timer
      grounded: false,
      wasAboveNeck: opts.y < 0
    };
    bodies.push(b);
    return b;
  }

  // circle vs segment: push out + bounce. Returns true on contact.
  function collideSeg(b, s, rest, dt) {
    var dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    var len2 = dx * dx + dy * dy;
    var t = ((b.x - s.x1) * dx + (b.y - s.y1) * dy) / (len2 || 1e-9);
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    var cx = s.x1 + dx * t, cy = s.y1 + dy * t;
    var nx = b.x - cx, ny = b.y - cy;
    var d2 = nx * nx + ny * ny;
    if (d2 >= b.r * b.r || d2 === 0) return false;
    var d = Math.sqrt(d2);
    nx /= d; ny /= d;
    var push = b.r - d;
    b.x += nx * push; b.y += ny * push;
    var vn = b.vx * nx + b.vy * ny;
    if (vn < 0) {
      // split velocity into normal + tangential
      var tvx = b.vx - vn * nx, tvy = b.vy - vn * ny;
      b.vx = tvx * CONFIG.FRICTION - vn * nx * rest;
      b.vy = tvy * CONFIG.FRICTION - vn * ny * rest;
      // impacts squash + spin from tangential slide
      if (vn < -140) { b.squash = 1; if (window.Sound) Sound.plink(b.r, -vn, b.colorIdx); }
      b.spin += (tvx * ny - tvy * nx) * 0.02;
    }
    return true;
  }

  // spatial hash for circle-circle
  function pairPass() {
    var cell = 0, i, b;
    for (i = 0; i < bodies.length; i++) if (bodies[i].r > cell) cell = bodies[i].r;
    cell = cell * 2.1 || 20;
    var grid = new Map();
    for (i = 0; i < bodies.length; i++) {
      b = bodies[i];
      var cx = Math.floor(b.x / cell), cy = Math.floor(b.y / cell);
      var key = cx * 65536 + cy;
      var arr = grid.get(key);
      if (!arr) grid.set(key, arr = []);
      arr.push(b);
      b._cx = cx; b._cy = cy;
    }
    for (i = 0; i < bodies.length; i++) {
      b = bodies[i];
      for (var ox = -1; ox <= 1; ox++) for (var oy = -1; oy <= 1; oy++) {
        var arr2 = grid.get((b._cx + ox) * 65536 + (b._cy + oy));
        if (!arr2) continue;
        for (var j = 0; j < arr2.length; j++) {
          var o = arr2[j];
          if (o === b || o._done) continue;
          resolvePair(b, o);
        }
      }
      b._done = true;
    }
    for (i = 0; i < bodies.length; i++) bodies[i]._done = false;
  }

  function wake(b) {
    if (!b.sleeping) return;
    b.sleeping = false;
    b.calm = 0; b.hadGround = false; b.driftT = 0;
    b.ax = b.x; b.ay = b.y;
    b.vx = 0; b.vy = 0;
    b.grounded = true; b.groundContact = true; // it WAS resting — fair start
  }

  function resolvePair(a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var rs = a.r + b.r;
    var d2 = dx * dx + dy * dy;
    if (d2 >= rs * rs) return;
    var d = Math.sqrt(d2) || 0.001;
    var nx = dx / d, ny = dy / d;
    // bookkeeping happens for every touching pair, awake or not
    a.touch++; b.touch++;
    if (ny > 0.55) { a.support = b; b.aboveN++; }        // b is below a
    else if (ny < -0.55) { b.support = a; a.aboveN++; }  // a is below b

    if (a.sleeping && b.sleeping) return; // the pile at rest stays at rest
    var overlap = rs - d;
    var ma = a.r * a.r, mb = b.r * b.r;

    if (a.sleeping || b.sleeping) {
      // one sleeper: the mover takes the whole correction; a hard enough hit
      // wakes the sleeper (that's how a landing ripples the surface)
      var s = a.sleeping ? a : b, m = a.sleeping ? b : a;
      var sign = m === b ? 1 : -1;
      // partial, capped correction — full-overlap shoves are what launched
      // guys up slopes (depenetration ejection)
      var corr0 = Math.min(overlap * 0.6, s.r * 0.4);
      m.x += sign * nx * corr0; m.y += sign * ny * corr0;
      var vn0 = (m.vx * nx + m.vy * ny) * sign;
      if (vn0 < 0) {
        m.vx -= sign * vn0 * nx * 1.15; m.vy -= sign * vn0 * ny * 1.15;
        if (vn0 < -170 || overlap > s.r * 0.55) wake(s);
      }
      // grip: sleepers hold movers back (tangential friction)
      var mu0 = frictionAt(m.y);
      var tx0 = -ny, ty0 = nx;
      var vt0 = m.vx * tx0 + m.vy * ty0;
      m.vx -= vt0 * mu0 * tx0; m.vy -= vt0 * mu0 * ty0;
      return;
    }

    var mt = ma + mb;
    // resolve only a fraction of the overlap per frame, with a hard cap and a
    // small slop we tolerate entirely — Box2D-style. Full instant separation
    // accumulates across a crowd into violent uphill ejections.
    if (overlap > 0.5) {
      var corr = Math.min(overlap * 0.45, Math.min(a.r, b.r) * 0.35);
      a.x -= nx * corr * (mb / mt); a.y -= ny * corr * (mb / mt);
      b.x += nx * corr * (ma / mt); b.y += ny * corr * (ma / mt);
    }
    var rvx = b.vx - a.vx, rvy = b.vy - a.vy;
    var vn = rvx * nx + rvy * ny;
    if (vn < 0) {
      var imp = -(1 + 0.1) * vn / (1 / ma + 1 / mb);
      a.vx -= imp * nx / ma; a.vy -= imp * ny / ma;
      b.vx += imp * nx / mb; b.vy += imp * ny / mb;
      var slide = rvx * ny - rvy * nx;
      a.spin += slide * 0.012; b.spin -= slide * 0.012;
    }
    // friction: contacts grip, so piles can actually lock up like sand
    // (without this the pile is a liquid and nobody ever comes to rest)
    var mu = frictionAt((a.y + b.y) / 2);
    var tx = -ny, ty = nx;
    var vt = rvx * tx + rvy * ty;
    var jf = vt * mu;
    a.vx += jf * tx * (mb / mt); a.vy += jf * ty * (mb / mt);
    b.vx -= jf * tx * (ma / mt); b.vy -= jf * ty * (ma / mt);
  }

  function step(dt, glass, gameT) {
    var C = CONFIG, i, b;
    curGlass = glass;
    var toBake = [];

    for (i = 0; i < bodies.length; i++) {
      b = bodies[i];
      b.touch = 0;
      b.aboveN = 0;
      b.support = null;
      if (b.squash > 0) b.squash = Math.max(0, b.squash - dt * 5);
      if (b.sleeping) continue; // asleep: no gravity, no motion, still solid
      b.vy += C.GRAVITY * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.angle += b.spin * dt;
      b.spin *= 0.985;
      b.grounded = false;
      b.groundContact = false; // touching real ground (floor/pile/mass), not a buddy
    }

    // walls
    for (i = 0; i < bodies.length; i++) {
      b = bodies[i];
      if (b.sleeping) continue;
      var segs = glass.segs;
      for (var k = 0; k < segs.length; k++) {
        var s = segs[k];
        // quick y-reject
        if (b.y + b.r < Math.min(s.y1, s.y2) || b.y - b.r > Math.max(s.y1, s.y2)) continue;
        if (collideSeg(b, s, C.RESTITUTION, dt)) {
          if (Math.abs(s.y1 - s.y2) < Math.abs(s.x1 - s.x2)) { // floorish
            b.grounded = true;
            b.groundContact = true;
          }
        }
      }
    }

    // structure boxes: huts and towers are solid — land on the roof, slide off
    var boxes = Pile.obstacleBoxes;
    if (boxes.length) {
      for (i = 0; i < bodies.length; i++) {
        b = bodies[i];
        if (b.sleeping) continue;
        for (var bx = 0; bx < boxes.length; bx++) {
          var box = boxes[bx];
          if (b.x + b.r < box.x0 || b.x - b.r > box.x1 ||
              b.y + b.r < box.y0 || b.y - b.r > box.y1) continue;
          var ncx = U.clamp(b.x, box.x0, box.x1);
          var ncy = U.clamp(b.y, box.y0, box.y1);
          var ddx = b.x - ncx, ddy = b.y - ncy;
          var dd2 = ddx * ddx + ddy * ddy;
          if (dd2 > b.r * b.r) continue;
          if (dd2 > 0.0001) { // outside the box: push along the contact normal
            var dd = Math.sqrt(dd2);
            var nnx = ddx / dd, nny = ddy / dd;
            b.x += nnx * (b.r - dd); b.y += nny * (b.r - dd);
            var vnb = b.vx * nnx + b.vy * nny;
            if (vnb < 0) {
              b.vx -= vnb * nnx * 1.18; b.vy -= vnb * nny * 1.18;
              if (vnb < -150) { b.squash = 1; if (window.Sound) Sound.plink(b.r, -vnb, b.colorIdx); }
            }
            if (nny < -0.55) { b.grounded = true; b.groundContact = true; } // on the roof
          } else { // center inside: eject out the top
            b.y = box.y0 - b.r;
            if (b.vy > 0) b.vy = 0;
            b.grounded = true; b.groundContact = true;
          }
        }
      }
    }

    // pile / mass surfaces
    for (i = 0; i < bodies.length; i++) {
      b = bodies[i];
      if (b.sleeping) continue;
      var g = Pile.groundAt(b.x, b.y);
      if (g && b.y + b.r > g.y) {
        b.y = g.y - b.r;
        if (b.vy > 0) {
          if (b.vy > 150) { b.squash = 1; if (window.Sound) Sound.plink(b.r, b.vy, b.colorIdx); }
          b.vy = -b.vy * C.RESTITUTION * 0.6;
          if (Math.abs(b.vy) < 20) b.vy = 0;
        }
        // slide along slope
        b.vx = (b.vx + g.slope * 260 * dt) * 0.94;
        b.spin += g.slope * 1.5 * dt;
        b.grounded = true;
        b.groundContact = true;
      }
    }

    pairPass();

    // groundedness climbs the stack: if the guy under you is grounded, so are
    // you. Bottom-most first so chains resolve in one sweep. Then crowd
    // damping — dense rafts calm down instead of jiggling forever.
    var byY = bodies.slice().sort(function (p, q) { return q.y - p.y; });
    for (i = 0; i < byY.length; i++) {
      b = byY[i];
      if (b.sleeping) continue;
      if (!b.grounded && b.support && (b.support.grounded || b.support.sleeping)) {
        b.grounded = true;
      }
      if (b.touch >= 3 && Math.abs(b.vx) + Math.abs(b.vy) < 90) {
        b.vx *= 0.86; b.vy *= 0.86; b.spin *= 0.88;
      }
      if (b.grounded && Math.abs(b.vx) + Math.abs(b.vy) < C.QUIET_SPEED * 2) {
        b.spin *= 0.9;
      }
    }

    // hard containment: crowd-push can tunnel a body through a wall segment,
    // and once outside, the wall normal pushes it further out. Nobody leaves.
    for (i = 0; i < bodies.length; i++) {
      b = bodies[i];
      if (b.sleeping) continue;
      if (b.y > glass.rimY + b.r && b.y < glass.floorY) {
        var hwHere = glass.hwAt(b.y) - b.r * 0.5;
        if (hwHere > 0 && Math.abs(b.x) > hwHere) {
          b.x = (b.x > 0 ? 1 : -1) * hwHere;
          b.vx *= -0.3;
        }
      }
    }

    // bookkeeping: settling, sleep, jams, neck passage, escape hatch
    var frameMod = ((gameT / dt) | 0) % 20;
    for (i = bodies.length - 1; i >= 0; i--) {
      b = bodies[i];

      if (b.sleeping) {
        // burial: covered sleepers become pile paint (invisible change)
        if (b.aboveN >= 2) {
          b.coveredT += dt;
          if (b.coveredT > 1.2) {
            var bi = bodies.indexOf(b);
            bodies.splice(bi, 1);
            Pile.bakeBody(b);
            continue;
          }
        } else if (b.coveredT > 0) b.coveredT = Math.max(0, b.coveredT - dt);
        // staggered support recheck: if the ground drained out from under a
        // sleeper (and no buddy holds him), he wakes and falls
        if (i % 20 === frameMod && !b.support) {
          var gs = Pile.groundAt(b.x, b.y);
          if (!gs || gs.y - (b.y + b.r) > b.r * 1.2) wake(b);
        }
        continue;
      }

      var speed = Math.abs(b.vx) + Math.abs(b.vy);

      if (b.wasAboveNeck && b.y > glass.neckBottomY + b.r) {
        b.wasAboveNeck = false;
        lastNeckPassT = gameT;
      }

      // neck jam comedy: stuck in/near the neck, slow, for a while -> POP.
      // Never while a REAL mountain plugs the throat (resting on the plug is
      // not a jam) — but a few stray clog-bakes don't count as a mountain.
      var plugged = Pile.top.volume > glass.capacity * 0.02;
      var inNeck = Math.abs(b.y) < glass.H * 0.09 &&
                   Math.abs(b.x) < glass.neckHW * 2.5 && !plugged;
      if (inNeck && speed < 30) {
        b.jamT += dt;
        if (b.jamT > C.JAM_SECONDS) {
          b.jamT = 0;
          b.x = (Math.random() - 0.5) * glass.neckHW * 0.6;
          b.y = glass.neckBottomY + b.r * 1.5;
          b.vy = 260; b.vx = (Math.random() - 0.5) * 120;
          b.spin = (Math.random() - 0.5) * 14;
          b.squash = 1;
          if (window.Sound) Sound.pop();
          if (window.FX) FX.puff(0, glass.neckBottomY, b.r * 2.5);
        }
      } else b.jamT = 0;

      // settle -> SCORE, but keep living. "At rest" is judged by POSITION DRIFT,
      // not speed — crowded sand jiggles fast but goes nowhere, and jiggling
      // in place absolutely counts as settled. Rolling somewhere does not.
      b.hadGround = b.hadGround || b.groundContact;
      b.driftT += dt;
      if (b.driftT >= 0.8) {
        var moved = Math.abs(b.x - b.ax) + Math.abs(b.y - b.ay);
        if (moved < C.R0 && b.hadGround) b.calm++;
        else {
          b.calm = 0;
          if (b.settled && moved > C.R0 * 1.5) b.settled = false; // rolling again
        }
        b.ax = b.x; b.ay = b.y; b.driftT = 0; b.hadGround = false;
      }
      // sleep is only allowed where sand legitimately rests: the bottom
      // chamber, or on a real mountain. Never in the funnel or throat —
      // that sand must keep flowing.
      var mayRest = b.y > glass.neckBottomY + b.r ||
                    (b.y < glass.neckTopY && Pile.top.count > 50);
      if (!b.settled && b.calm >= 1 && mayRest) {
        b.settled = true;
        b.sleeping = true; // sand at rest sleeps in place until disturbed
        b.vx = 0; b.vy = 0; b.spin = 0;
        // bottom-chamber guys cash in here; mountain guys pay when they pour down
        if (b.y >= glass.neckTopY) Econ.earnGuy(b);
        continue;
      }

      // escaped the glass? (should not happen — put it back on top, nothing is lost)
      if (b.y > glass.floorY + 400 || Math.abs(b.x) > glass.W * 1.6 ||
          b.y < glass.rimY - 4000) {
        b.x = (Math.random() - 0.5) * glass.rimHW;
        b.y = glass.rimY - CONFIG.SPAWN_HEIGHT;
        b.vx = 0; b.vy = 0; b.calm = 0; b.settled = false;
      }
    }

    // near the live cap? bake settled guys, lowest first (prefer the buried and
    // ground-touching; fall back only if the cap leaves no choice). Trim WELL
    // below the drain's release gate (LIVE_CAP-10) or a saturated queue locks
    // the drain shut and the mountain grows forever.
    if (bodies.length > C.LIVE_CAP - 20) {
      var quietish = bodies.filter(function (q) {
        return (q.sleeping || (q.settled && q.groundContact)) && toBake.indexOf(q) < 0;
      }).sort(function (a2, b2) { return b2.y - a2.y; });
      if (!quietish.length) {
        // prefer bottom-chamber guys; only bake the funnel queue upstairs as a
        // last resort (that's sand backing up into a pool, which then drains)
        quietish = bodies.filter(function (q) {
          return q.grounded && q.y >= glass.neckTopY && toBake.indexOf(q) < 0;
        }).sort(function (a2, b2) { return b2.y - a2.y; });
      }
      if (!quietish.length) {
        quietish = bodies.filter(function (q) {
          return q.grounded && toBake.indexOf(q) < 0;
        }).sort(function (a2, b2) { return b2.y - a2.y; });
      }
      var need = bodies.length - (C.LIVE_CAP - 40);
      for (i = 0; i < quietish.length && i < need; i++) toBake.push(quietish[i]);
    }

    // bake bottom-most first so the pile grows from below
    toBake.sort(function (a3, b3) { return b3.y - a3.y; });
    for (i = 0; i < toBake.length; i++) {
      var idx = bodies.indexOf(toBake[i]);
      if (idx >= 0) {
        bodies.splice(idx, 1);
        Pile.bakeBody(toBake[i]);
      }
    }

    // global anti-softlock: nothing passed the neck for a while though guys wait above
    if (gameT - lastNeckPassT > 14 && bodies.length > 0) {
      var above = null;
      for (i = 0; i < bodies.length; i++) {
        b = bodies[i];
        if (b.y < glass.neckTopY && (!above || b.y > above.y)) above = b;
      }
      // only if a real mountain isn't the thing (its drain has its own throttle)
      if (above && Pile.top.volume < glass.capacity * 0.02 &&
          above.y > glass.rimY + glass.H * 0.25) {
        above.x = 0; above.y = glass.neckBottomY + above.r * 1.5;
        above.vy = 240; above.squash = 1;
        if (window.Sound) Sound.pop();
      }
      lastNeckPassT = gameT;
    }
  }

  function clear() { bodies.length = 0; }

  // flip: rotate every live body 180° about the origin
  function rotateAll() {
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i];
      b.x = -b.x; b.y = -b.y;
      b.vx = 0; b.vy = 0; b.jamT = 0;
      b.calm = 0; b.settled = false; b.sleeping = false; b.coveredT = 0;
      b.ax = b.x; b.ay = b.y;
      b.wasAboveNeck = b.y < 0;
    }
  }

  window.Phys = { bodies: bodies, spawn: spawn, step: step, clear: clear,
                  rotateAll: rotateAll,
                  noteNeckPass: function (t) { lastNeckPassT = t; } };
})();
