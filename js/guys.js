/* Sandmen: spawning + drawing. Personality over realism — limbs are procedural
   rendering driven by motion, never physics. Also home of FX (particles).
   Globals: Guys, FX */
(function () {
  'use strict';

  var animT = 0; // shared animation clock

  function hexFor(b) {
    if (b.gold) return GOLD_HEX;
    var p = PALETTE[b.colorIdx];
    return p ? p.hex : '#c9a86a';
  }

  // ---------- spawning ----------

  function drop(n, glass) {
    for (var i = 0; i < n; i++) {
      var r = Econ.guyR() * (0.93 + Math.random() * 0.14);
      var gold = Math.random() < Econ.goldChance();
      Phys.spawn({
        x: (Math.random() - 0.5) * glass.rimHW * 1.4,
        y: glass.rimY - CONFIG.SPAWN_HEIGHT - Math.random() * 60 - i * 26,
        vx: (Math.random() - 0.5) * 40,
        vy: 40 + Math.random() * 60,
        r: r,
        colorIdx: (Math.random() * Econ.colorCount()) | 0,
        gold: gold
      });
      Econ.counts.spawned++;
      if (gold) Econ.counts.gold++;
    }
  }

  // ---------- drawing ----------

  // zoom: world->screen scale, for level-of-detail
  function drawGuy(ctx, b, zoom, falling) {
    var sr = b.r * zoom;
    var hex = hexFor(b);
    if (sr < 2.2) { // tiny: a dot
      ctx.fillStyle = hex;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, U.TAU); ctx.fill();
      return;
    }
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle);
    var sq = b.squash * 0.3;
    ctx.scale(1 + sq, 1 - sq);

    var outline = U.shade(hex, -0.55);
    var lw = Math.max(1.5 / zoom, b.r * 0.18);

    // limbs (only when big enough to matter)
    if (sr > 6) {
      var flail = falling ? Math.min(1, (Math.abs(b.vx) + Math.abs(b.vy)) / 400) : 0;
      var t = animT * 10 + b.face * 2.1;
      ctx.strokeStyle = outline;
      ctx.lineWidth = b.r * 0.34;
      ctx.lineCap = 'round';
      for (var s = -1; s <= 1; s += 2) {
        // arms
        var aa = s * (1.9 + Math.sin(t + s) * (0.25 + flail * 1.3));
        ctx.beginPath();
        ctx.moveTo(s * b.r * 0.55, -b.r * 0.15);
        ctx.lineTo(s * b.r * 0.55 + Math.sin(aa) * b.r * 0.75,
                   -b.r * 0.15 - Math.cos(aa) * b.r * 0.75 * -1);
        ctx.stroke();
        // legs
        var la = s * (0.5 + Math.sin(t * 1.3 + s * 2) * (0.15 + flail * 0.8));
        ctx.beginPath();
        ctx.moveTo(s * b.r * 0.35, b.r * 0.6);
        ctx.lineTo(s * b.r * 0.35 + Math.sin(la) * b.r * 0.5,
                   b.r * 0.6 + Math.cos(la) * b.r * 0.55);
        ctx.stroke();
      }
    }

    // body
    ctx.fillStyle = hex;
    ctx.strokeStyle = outline;
    ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(0, 0, b.r, 0, U.TAU);
    ctx.fill();
    if (sr > 3.5) ctx.stroke();

    // cel shade: darker crescent lower-right
    if (sr > 5) {
      ctx.save();
      ctx.beginPath(); ctx.arc(0, 0, b.r, 0, U.TAU); ctx.clip();
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.arc(-b.r * 0.28, -b.r * 0.28, b.r * 1.15, 0, U.TAU);
      ctx.rect(-b.r, -b.r, 2 * b.r, 2 * b.r);
      ctx.fill('evenodd');
      ctx.restore();
    }

    // face — every color is a personality (mid-air panic is universal, though)
    if (sr > 6.5) drawFace(ctx, b, falling);

    // golden sparkle
    if (b.gold && sr > 3) {
      var tw = (Math.sin(animT * 6 + b.x) + 1) / 2;
      ctx.fillStyle = 'rgba(255,255,220,' + (0.4 + tw * 0.6) + ')';
      var spx = b.r * 0.5, spy = -b.r * 0.5, ss = b.r * 0.28 * (0.7 + tw * 0.5);
      ctx.beginPath();
      ctx.moveTo(spx, spy - ss); ctx.lineTo(spx + ss * 0.3, spy - ss * 0.3);
      ctx.lineTo(spx + ss, spy); ctx.lineTo(spx + ss * 0.3, spy + ss * 0.3);
      ctx.lineTo(spx, spy + ss); ctx.lineTo(spx - ss * 0.3, spy + ss * 0.3);
      ctx.lineTo(spx - ss, spy); ctx.lineTo(spx - ss * 0.3, spy - ss * 0.3);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  // Coral grins, Amber dozes, Sky is startled, Mint is serene, Lilac doubts
  // everything, Rose blushes, Lemon is manic, Teal is too cool for the glass,
  // Tangerine worries, Berry schemes.
  function drawFace(ctx, b, falling) {
    var r = b.r, ink = '#1c2233';
    var ey = -r * 0.18, ex = r * 0.32;
    var kind = b.colorIdx % 10;
    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    ctx.lineWidth = r * 0.09;
    ctx.lineCap = 'round';

    // eyes
    if (falling) { // wide panic eyes for everyone
      ctx.beginPath(); ctx.arc(-ex, ey, r * 0.13, 0, U.TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(ex, ey, r * 0.13, 0, U.TAU); ctx.fill();
    } else if (kind === 1) { // Amber: asleep on arrival
      ctx.beginPath();
      ctx.moveTo(-ex - r * 0.13, ey); ctx.lineTo(-ex + r * 0.13, ey);
      ctx.moveTo(ex - r * 0.13, ey); ctx.lineTo(ex + r * 0.13, ey);
      ctx.stroke();
    } else if (kind === 3) { // Mint: serene closed arcs
      ctx.beginPath(); ctx.arc(-ex, ey + r * 0.05, r * 0.13, Math.PI, 0); ctx.stroke();
      ctx.beginPath(); ctx.arc(ex, ey + r * 0.05, r * 0.13, Math.PI, 0); ctx.stroke();
    } else if (kind === 7) { // Teal: sunglasses, always
      ctx.fillRect(-ex - r * 0.22, ey - r * 0.12, (ex + r * 0.22) * 2, r * 0.24);
    } else if (kind === 9) { // Berry: scheming squint
      ctx.beginPath(); ctx.arc(-ex, ey, r * 0.1, 0, U.TAU); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(ex - r * 0.13, ey - r * 0.04); ctx.lineTo(ex + r * 0.13, ey + r * 0.04);
      ctx.stroke();
    } else {
      var er = kind === 6 ? r * 0.15 : (kind === 2 ? r * 0.14 : r * 0.11); // Lemon/Sky big
      ctx.beginPath(); ctx.arc(-ex, ey, er, 0, U.TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(ex, ey, er, 0, U.TAU); ctx.fill();
      if (kind === 4) { // Lilac: one skeptical brow
        ctx.beginPath();
        ctx.moveTo(ex - r * 0.16, ey - r * 0.26); ctx.lineTo(ex + r * 0.16, ey - r * 0.34);
        ctx.stroke();
      }
    }

    // mouth
    ctx.beginPath();
    if (falling || kind === 2) {                 // Sky (and any faller): "o"
      ctx.arc(0, r * 0.28, r * 0.16, 0, U.TAU);
    } else if (kind === 8) {                     // Tangerine: worried
      ctx.arc(0, r * 0.42, r * 0.22, 1.25 * Math.PI, 1.75 * Math.PI);
    } else if (kind === 4) {                     // Lilac: unconvinced line
      ctx.moveTo(-r * 0.2, r * 0.26); ctx.lineTo(r * 0.2, r * 0.26);
    } else if (kind === 9) {                     // Berry: smirk
      ctx.arc(r * 0.08, r * 0.2, r * 0.22, 0.15 * Math.PI, 0.6 * Math.PI);
    } else if (kind === 6) {                     // Lemon: manic grin
      ctx.arc(0, r * 0.14, r * 0.36, 0.15 * Math.PI, 0.85 * Math.PI);
    } else if (kind === 1) {                     // Amber: tiny snore mouth
      ctx.arc(0, r * 0.3, r * 0.08, 0, U.TAU);
    } else {                                     // default happy arc
      ctx.arc(0, r * 0.18, r * 0.3, 0.25 * Math.PI, 0.75 * Math.PI);
    }
    ctx.stroke();

    if (kind === 5 && !falling) { // Rose: blush
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath(); ctx.arc(-ex - r * 0.14, ey + r * 0.3, r * 0.09, 0, U.TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(ex + r * 0.14, ey + r * 0.3, r * 0.09, 0, U.TAU); ctx.fill();
    }
  }

  // static stamp for the baked pile canvas (tucked pose, always "full" detail —
  // the canvas keeps whatever resolution it has)
  function stampGuy(pctx, b) {
    var hex = hexFor(b);
    var outline = U.shade(hex, -0.55);
    pctx.save();
    pctx.translate(b.x, b.y);
    pctx.rotate(b.angle);
    pctx.fillStyle = hex;
    pctx.strokeStyle = outline;
    pctx.lineWidth = Math.max(1, b.r * 0.16);
    pctx.beginPath(); pctx.arc(0, 0, b.r, 0, U.TAU);
    pctx.fill(); pctx.stroke();
    // sleepy face
    pctx.strokeStyle = '#1c2233';
    pctx.lineWidth = b.r * 0.1;
    pctx.beginPath();
    pctx.moveTo(-b.r * 0.42, -b.r * 0.15); pctx.lineTo(-b.r * 0.2, -b.r * 0.15);
    pctx.moveTo(b.r * 0.2, -b.r * 0.15); pctx.lineTo(b.r * 0.42, -b.r * 0.15);
    pctx.stroke();
    pctx.beginPath();
    pctx.arc(0, b.r * 0.22, b.r * 0.24, 0.3 * Math.PI, 0.7 * Math.PI);
    pctx.stroke();
    if (b.gold) {
      pctx.fillStyle = 'rgba(255,255,220,0.8)';
      pctx.beginPath(); pctx.arc(b.r * 0.4, -b.r * 0.4, b.r * 0.16, 0, U.TAU); pctx.fill();
    }
    pctx.restore();
  }

  function renderLive(ctx, zoom) {
    var bodies = Phys.bodies;
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i];
      drawGuy(ctx, b, zoom, !b.grounded && Math.abs(b.vy) > 60);
    }
  }

  function tick(dt) { animT += dt; }

  // ================= FX =================

  var world = [];  // particles in world space
  var screen = []; // particles in screen space (confetti etc.)
  var floaterCount = 0;

  function floater(x, y, text, color) {
    if (floaterCount >= CONFIG.MAX_FLOATERS) return;
    floaterCount++;
    world.push({ kind: 'text', x: x, y: y, vy: -60, life: 1.1, max: 1.1,
                 text: text, color: color || '#ffe9c2' });
  }
  function puff(x, y, r) {
    world.push({ kind: 'puff', x: x, y: y, r: r * 0.4, gr: r * 2.4, life: 0.5, max: 0.5 });
  }
  function debris(x, y, hex, n, spread) {
    for (var i = 0; i < (n || 6); i++) {
      world.push({ kind: 'chip', x: x, y: y,
                   vx: (Math.random() - 0.5) * (spread || 260),
                   vy: -Math.random() * 260 - 60,
                   rot: Math.random() * U.TAU, vr: (Math.random() - 0.5) * 10,
                   s: 4 + Math.random() * 7, color: hex,
                   life: 1.6, max: 1.6 });
    }
  }
  function confettiBurst(sx, sy, n) {
    var colors = ['#ff6b6b', '#ffb84d', '#4dd599', '#4dabff', '#b78aff', '#ffe066'];
    for (var i = 0; i < n; i++) {
      screen.push({ kind: 'conf', x: sx, y: sy,
                    vx: (Math.random() - 0.5) * 900,
                    vy: -Math.random() * 700 - 150,
                    rot: Math.random() * U.TAU, vr: (Math.random() - 0.5) * 14,
                    s: 6 + Math.random() * 9,
                    color: colors[(Math.random() * colors.length) | 0],
                    life: 2.6, max: 2.6 });
    }
  }
  function sparkleAt(x, y, r) {
    world.push({ kind: 'puff', x: x, y: y, r: r * 0.2, gr: r * 1.4, life: 0.4, max: 0.4, gold: true });
  }
  // a tiny grain kicked up by an avalanche, rolling downhill
  function grain(x, y, dir, hex) {
    world.push({ kind: 'grain', x: x, y: y,
                 vx: dir * (30 + Math.random() * 60),
                 vy: -(10 + Math.random() * 40),
                 s: CONFIG.R0 * (0.25 + Math.random() * 0.2),
                 color: hex, life: 0.5 + Math.random() * 0.3, max: 0.8 });
  }

  function stepList(list, dt, grav) {
    for (var i = list.length - 1; i >= 0; i--) {
      var p = list[i];
      p.life -= dt;
      if (p.life <= 0) {
        if (p.kind === 'text') floaterCount--;
        list.splice(i, 1);
        continue;
      }
      if (p.vx != null) { p.x += p.vx * dt; p.vx *= 0.99; }
      if (p.vy != null) { p.y += p.vy * dt; if (grav && p.kind !== 'text') p.vy += 700 * dt; }
      if (p.vr != null) p.rot += p.vr * dt;
      if (p.kind === 'puff') p.r += (p.gr - p.r) * dt * 6;
    }
  }
  function fxStep(dt) { stepList(world, dt, true); stepList(screen, dt, true); }

  function renderWorld(ctx, zoom) {
    for (var i = 0; i < world.length; i++) {
      var p = world[i], a = p.life / p.max;
      if (p.kind === 'text') {
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.font = '900 ' + Math.max(14 / zoom, CONFIG.R0 * 1.7) + 'px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(p.text, p.x, p.y);
      } else if (p.kind === 'puff') {
        ctx.globalAlpha = a * (p.gold ? 0.85 : 0.4);
        ctx.fillStyle = p.gold ? '#ffe9a0' : '#c8b89a';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, U.TAU); ctx.fill();
      } else if (p.kind === 'grain') {
        ctx.globalAlpha = a * 0.9;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.s, 0, U.TAU); ctx.fill();
      } else if (p.kind === 'chip') {
        ctx.globalAlpha = a;
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.strokeStyle = 'rgba(20,26,48,0.7)';
        ctx.lineWidth = 1.5;
        ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s);
        ctx.strokeRect(-p.s / 2, -p.s / 2, p.s, p.s);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  function renderScreen(ctx) {
    for (var i = 0; i < screen.length; i++) {
      var p = screen[i], a = Math.min(1, p.life / 0.6);
      ctx.globalAlpha = a;
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  window.Guys = { drop: drop, drawGuy: drawGuy, stampGuy: stampGuy,
                  renderLive: renderLive, tick: tick, hexFor: hexFor };
  window.FX = { floater: floater, puff: puff, debris: debris, grain: grain,
                confettiBurst: confettiBurst, sparkleAt: sparkleAt,
                step: fxStep, renderWorld: renderWorld, renderScreen: renderScreen,
                worldList: world, screenList: screen };
})();
