/* Sandmen: spawning + drawing. Personality over realism — limbs are procedural
   rendering driven by motion, never physics. Also home of FX (particles).
   Globals: Guys, FX */
(function () {
  'use strict';

  var animT = 0; // shared animation clock
  var TRAIL_LEN = 3; // fall-trail sample count (world x/y pairs)
  // Bumped once per real update() step (see tick()). doomcam.js runs its own
  // independent requestAnimationFrame loop and calls drawGuy() a second time
  // per real frame for any falling body inside its inset window, with no
  // physics step in between — gate the trail SAMPLE (not the draw) on this
  // counter so a body only records one new point per real tick no matter how
  // many times it gets drawn that frame.
  var trailTick = 0;

  function hexFor(b) {
    if (b.gold) return GOLD_HEX;
    var p = PALETTE[b.colorIdx];
    return p ? p.hex : '#c9a86a';
  }

  // (s4: polygon grain bodies tried and CUT same day — Zach: circles are the
  // cheap ones, polygons made every contact pricier for no gain. The grainy
  // "lays like sand" feel comes from friction + the raft-freeze sleep fix.)

  // ---------- spawning ----------

  function drop(n, glass) {
    for (var i = 0; i < n; i++) {
      var r = Econ.guyR() * (0.93 + Math.random() * 0.14);
      var gold = Math.random() < Econ.goldChance();
      // s4: the Strange Ones — rare character sandmen, era 4+ (never gold;
      // gold is already its own celebrity). Weighted pick from CHARACTERS.
      var charIdx = null;
      if (!gold && Econ.era >= 4 && window.CHARACTERS && Math.random() < CHAR_CHANCE) {
        var wsum = 0, ci;
        for (ci = 0; ci < CHARACTERS.length; ci++) wsum += CHARACTERS[ci].weight;
        var roll = Math.random() * wsum;
        for (ci = 0; ci < CHARACTERS.length; ci++) {
          roll -= CHARACTERS[ci].weight;
          if (roll <= 0) { charIdx = ci; break; }
        }
      }
      Phys.spawn({
        x: (Math.random() - 0.5) * glass.rimHW * 1.4,
        y: glass.rimY - CONFIG.SPAWN_HEIGHT - Math.random() * 60 - i * 26,
        vx: (Math.random() - 0.5) * 40,
        vy: 40 + Math.random() * 60,
        r: r,
        colorIdx: (Math.random() * Econ.colorCount()) | 0,
        gold: gold,
        charIdx: charIdx
      });
      Econ.counts.spawned++;
      if (gold) Econ.counts.gold++;
    }
  }

  // ---------- drawing ----------

  // a few fading world-space dots behind a falling body — no save/restore,
  // cheap enough for the whole pour column every frame
  function drawTrail(ctx, b, hex) {
    var t = b._trail, n = t.length / 2; // stored points, most-recent last
    if (n < 2) return;
    ctx.fillStyle = hex;
    for (var i = 0; i < n - 1; i++) { // skip the current position (drawn as the body)
      var age = n - 1 - i; // 1 = just behind current, grows toward the tail
      var a = 0.28 * (1 - age / n);
      if (a < 0.03) continue;
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(t[i * 2], t[i * 2 + 1], b.r * (0.4 + 0.25 * (i + 1) / n), 0, U.TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // a small twinkling diamond — the cheap gold tell for guys too tiny for
  // the full 8-point sparkle below (ROADMAP #7: the old sr>3 gate went dark
  // at era 6's default zoom, exactly the era that introduces gold guys)
  function drawMiniGold(ctx, cx, cy, ss) {
    var tw = (Math.sin(animT * 6 + cx) + 1) / 2;
    ctx.fillStyle = 'rgba(255,255,220,' + (0.5 + tw * 0.5) + ')';
    ctx.beginPath();
    ctx.moveTo(cx, cy - ss); ctx.lineTo(cx + ss, cy);
    ctx.lineTo(cx, cy + ss); ctx.lineTo(cx - ss, cy);
    ctx.closePath(); ctx.fill();
  }

  // zoom: world->screen scale, for level-of-detail
  function drawGuy(ctx, b, zoom, falling) {
    var sr = b.r * zoom;
    var hex = hexFor(b);

    // pour trail: keeps a tiny ring buffer of prior world x/y right on the
    // body (falling only — grounded guys clear it so a later re-fall doesn't
    // start with a stale jump-cut tail). Covers the atomization tiny guys too.
    if (falling) {
      if (!b._trail) b._trail = [];
      if (b._trailTick !== trailTick) {           // once per real tick, however many times we're drawn
        b._trailTick = trailTick;
        b._trail.push(b.x, b.y);
        if (b._trail.length > TRAIL_LEN * 2) b._trail.splice(0, b._trail.length - TRAIL_LEN * 2);
      }
      drawTrail(ctx, b, hex);
    } else if (b._trail && b._trail.length) {
      b._trail.length = 0;
    }

    if (sr < 2.2) { // tiny: a dot, but bold outline + a 2px eye pair survive the shrink
      ctx.fillStyle = hex;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, U.TAU); ctx.fill();
      if (sr > 1.1) {
        ctx.strokeStyle = U.shade(hex, -0.55);
        ctx.lineWidth = Math.max(0.6 / zoom, b.r * 0.2);
        ctx.stroke();
        var eyeR = Math.max(0.5 / zoom, b.r * 0.14);
        var eyeOff = b.r * 0.32;
        ctx.fillStyle = '#1c2233';
        ctx.beginPath(); ctx.arc(b.x - eyeOff, b.y - b.r * 0.1, eyeR, 0, U.TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(b.x + eyeOff, b.y - b.r * 0.1, eyeR, 0, U.TAU); ctx.fill();
      }
      if (b.gold) drawMiniGold(ctx, b.x, b.y, Math.max(1 / zoom, b.r * 0.35));
      return;
    }
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle);
    var sq = b.squash * 0.3;
    ctx.scale(1 + sq, 1 - sq);

    // s4: the Strange Ones (rare era-4+ character sandmen). The Pale One is
    // translucent head to toe; ctx.restore() below resets the alpha.
    var ch = b.charIdx != null && window.CHARACTERS ? CHARACTERS[b.charIdx] : null;
    if (ch && ch.id === 'ghost') ctx.globalAlpha = 0.55;

    var outline = U.shade(hex, -0.55);
    var lw = Math.max(1.5 / zoom, b.r * 0.18);

    // (s4: limbs removed entirely — Zach's call. Simple round guys, faces
    // carry all the personality, and every guy is cheaper to draw.)

    // body
    ctx.fillStyle = hex;
    ctx.strokeStyle = outline;
    ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(0, 0, b.r, 0, U.TAU);
    ctx.fill();
    if (sr > 1.5) ctx.stroke(); // lowered so the bold outline survives into the dot tier

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

    // face — every color is a personality (mid-air panic is universal, though).
    // The faceless strangers (ghost/cyclops/knight) bring their own instead.
    if (sr > 6.5 && !(ch && ch.noFace)) drawFace(ctx, b, falling);

    // stranger gear rides on top of (or replaces) the face
    if (ch && sr > 4.5) drawCharacter(ctx, b, ch);

    // golden sparkle: full 8-point star once large enough to read it; below
    // that, the small diamond so gold still reads at era-6 default zoom
    if (b.gold) {
      if (sr > 3) {
        var tw = (Math.sin(animT * 6 + b.x) + 1) / 2;
        ctx.fillStyle = 'rgba(255,255,220,' + (0.4 + tw * 0.6) + ')';
        var spx = b.r * 0.5, spy = -b.r * 0.5, ss = b.r * 0.28 * (0.7 + tw * 0.5);
        ctx.beginPath();
        ctx.moveTo(spx, spy - ss); ctx.lineTo(spx + ss * 0.3, spy - ss * 0.3);
        ctx.lineTo(spx + ss, spy); ctx.lineTo(spx + ss * 0.3, spy + ss * 0.3);
        ctx.lineTo(spx, spy + ss); ctx.lineTo(spx - ss * 0.3, spy + ss * 0.3);
        ctx.lineTo(spx - ss, spy); ctx.lineTo(spx - ss * 0.3, spy - ss * 0.3);
        ctx.closePath(); ctx.fill();
      } else {
        drawMiniGold(ctx, b.r * 0.45, -b.r * 0.45, Math.max(1 / zoom, b.r * 0.35));
      }
    }
    ctx.restore();
  }

  // s4: the Strange Ones' gear, drawn in body-local coords (post-rotate).
  // Each is a few primitives in the same chunky ink as everything else.
  function drawCharacter(ctx, b, ch) {
    var r = b.r, ink = '#141a2b';
    ctx.lineCap = 'round';
    if (ch.id === 'gent') {          // top hat + monocle (lifted ink so the
      ctx.fillStyle = '#39436f';     // crown reads against the night sky)
      ctx.fillRect(-r * 0.5, -r * 0.92, r * 1.0, r * 0.14);
      ctx.fillRect(-r * 0.32, -r * 1.5, r * 0.64, r * 0.6);
      ctx.fillStyle = '#b7413f';     // a dapper hat band
      ctx.fillRect(-r * 0.32, -r * 1.04, r * 0.64, r * 0.12);
      ctx.strokeStyle = ink; ctx.lineWidth = r * 0.07;
      ctx.beginPath(); ctx.arc(r * 0.32, -r * 0.18, r * 0.22, 0, U.TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(r * 0.32, r * 0.04); ctx.lineTo(r * 0.34, r * 0.3); ctx.stroke();
    } else if (ch.id === 'ghost') {  // hollow eyes + a small wail
      ctx.strokeStyle = ink; ctx.lineWidth = r * 0.1;
      ctx.beginPath(); ctx.arc(-r * 0.3, -r * 0.16, r * 0.15, 0, U.TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(r * 0.3, -r * 0.16, r * 0.15, 0, U.TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, r * 0.3, r * 0.14, 0, U.TAU); ctx.stroke();
    } else if (ch.id === 'cyclops') { // The Watcher: one enormous eye
      ctx.fillStyle = 'rgba(240,244,255,0.95)';
      ctx.beginPath(); ctx.arc(0, -r * 0.08, r * 0.34, 0, U.TAU); ctx.fill();
      ctx.strokeStyle = ink; ctx.lineWidth = r * 0.08;
      ctx.beginPath(); ctx.arc(0, -r * 0.08, r * 0.34, 0, U.TAU); ctx.stroke();
      ctx.fillStyle = ink;
      ctx.beginPath(); ctx.arc(0, -r * 0.08, r * 0.13, 0, U.TAU); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-r * 0.18, r * 0.42); ctx.lineTo(r * 0.18, r * 0.42); ctx.stroke();
    } else if (ch.id === 'sprout') { // stem + leaf on top
      ctx.strokeStyle = '#2e7d4f'; ctx.lineWidth = r * 0.1;
      ctx.beginPath(); ctx.moveTo(0, -r * 0.85); ctx.quadraticCurveTo(r * 0.05, -r * 1.15, r * 0.14, -r * 1.3); ctx.stroke();
      ctx.fillStyle = '#4dd599';
      ctx.beginPath();
      ctx.moveTo(r * 0.14, -r * 1.3);
      ctx.quadraticCurveTo(r * 0.5, -r * 1.55, r * 0.62, -r * 1.28);
      ctx.quadraticCurveTo(r * 0.38, -r * 1.12, r * 0.14, -r * 1.3);
      ctx.fill();
    } else if (ch.id === 'elder') {  // bushy brows + a grand beard
      ctx.fillStyle = 'rgba(236,240,248,0.92)';
      ctx.beginPath(); ctx.arc(0, r * 0.34, r * 0.44, 0, Math.PI, false); ctx.fill();
      ctx.strokeStyle = 'rgba(236,240,248,0.92)'; ctx.lineWidth = r * 0.12;
      ctx.beginPath(); ctx.moveTo(-r * 0.46, -r * 0.34); ctx.lineTo(-r * 0.16, -r * 0.4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(r * 0.16, -r * 0.4); ctx.lineTo(r * 0.46, -r * 0.34); ctx.stroke();
    } else if (ch.id === 'knight') { // bucket helm with a visor slit
      ctx.fillStyle = 'rgba(158,168,190,0.95)';
      ctx.fillRect(-r * 0.68, -r * 0.72, r * 1.36, r * 0.62);
      ctx.fillStyle = ink;
      ctx.fillRect(-r * 0.45, -r * 0.42, r * 0.9, r * 0.12);
      ctx.strokeStyle = ink; ctx.lineWidth = r * 0.07;
      ctx.strokeRect(-r * 0.68, -r * 0.72, r * 1.36, r * 0.62);
      ctx.beginPath();
      ctx.arc(0, r * 0.34, r * 0.2, 0.2 * Math.PI, 0.8 * Math.PI); ctx.stroke();
    }
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

  // Simplified per-color face for the baked pile: eyes + mouth only (no
  // limbs, no cel-shade crescent), shapes adapted from drawFace's non-falling
  // branch. NO ctx.clip() anywhere in here — resynthesize() calls stampGuy
  // on the order of 1e5 times per load/offline-catchup, and per-stamp clip()
  // is one of Canvas2D's slowest calls; a clip would turn a load hitch into
  // a multi-second freeze (ROADMAP #2).
  function stampFace(pctx, b) {
    var r = b.r, ink = '#1c2233';
    var ey = -r * 0.18, ex = r * 0.32;
    var kind = b.colorIdx % 10;
    pctx.fillStyle = ink;
    pctx.strokeStyle = ink;
    pctx.lineWidth = r * 0.09;
    pctx.lineCap = 'round';

    // eyes
    if (kind === 1) { // Amber: asleep on arrival
      pctx.beginPath();
      pctx.moveTo(-ex - r * 0.13, ey); pctx.lineTo(-ex + r * 0.13, ey);
      pctx.moveTo(ex - r * 0.13, ey); pctx.lineTo(ex + r * 0.13, ey);
      pctx.stroke();
    } else if (kind === 3) { // Mint: serene closed arcs
      pctx.beginPath(); pctx.arc(-ex, ey + r * 0.05, r * 0.13, Math.PI, 0); pctx.stroke();
      pctx.beginPath(); pctx.arc(ex, ey + r * 0.05, r * 0.13, Math.PI, 0); pctx.stroke();
    } else if (kind === 7) { // Teal: sunglasses, always
      pctx.fillRect(-ex - r * 0.22, ey - r * 0.12, (ex + r * 0.22) * 2, r * 0.24);
    } else if (kind === 9) { // Berry: scheming squint
      pctx.beginPath(); pctx.arc(-ex, ey, r * 0.1, 0, U.TAU); pctx.fill();
      pctx.beginPath();
      pctx.moveTo(ex - r * 0.13, ey - r * 0.04); pctx.lineTo(ex + r * 0.13, ey + r * 0.04);
      pctx.stroke();
    } else {
      var er = kind === 6 ? r * 0.15 : (kind === 2 ? r * 0.14 : r * 0.11); // Lemon/Sky big
      pctx.beginPath(); pctx.arc(-ex, ey, er, 0, U.TAU); pctx.fill();
      pctx.beginPath(); pctx.arc(ex, ey, er, 0, U.TAU); pctx.fill();
      if (kind === 4) { // Lilac: one skeptical brow
        pctx.beginPath();
        pctx.moveTo(ex - r * 0.16, ey - r * 0.26); pctx.lineTo(ex + r * 0.16, ey - r * 0.34);
        pctx.stroke();
      }
    }

    // mouth
    pctx.beginPath();
    if (kind === 2) {                             // Sky: "o"
      pctx.arc(0, r * 0.28, r * 0.16, 0, U.TAU);
    } else if (kind === 8) {                      // Tangerine: worried
      pctx.arc(0, r * 0.42, r * 0.22, 1.25 * Math.PI, 1.75 * Math.PI);
    } else if (kind === 4) {                      // Lilac: unconvinced line
      pctx.moveTo(-r * 0.2, r * 0.26); pctx.lineTo(r * 0.2, r * 0.26);
    } else if (kind === 9) {                      // Berry: smirk
      pctx.arc(r * 0.08, r * 0.2, r * 0.22, 0.15 * Math.PI, 0.6 * Math.PI);
    } else if (kind === 6) {                      // Lemon: manic grin
      pctx.arc(0, r * 0.14, r * 0.36, 0.15 * Math.PI, 0.85 * Math.PI);
    } else if (kind === 1) {                      // Amber: tiny snore mouth
      pctx.arc(0, r * 0.3, r * 0.08, 0, U.TAU);
    } else {                                       // default happy arc
      pctx.arc(0, r * 0.18, r * 0.3, 0.25 * Math.PI, 0.75 * Math.PI);
    }
    pctx.stroke();

    if (kind === 5) { // Rose: blush
      pctx.fillStyle = 'rgba(255,255,255,0.35)';
      pctx.beginPath(); pctx.arc(-ex - r * 0.14, ey + r * 0.3, r * 0.09, 0, U.TAU); pctx.fill();
      pctx.beginPath(); pctx.arc(ex + r * 0.14, ey + r * 0.3, r * 0.09, 0, U.TAU); pctx.fill();
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
    stampFace(pctx, b);
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

  function tick(dt) { animT += dt; trailTick++; }

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
        var fsize = Math.max(14 / zoom, CONFIG.R0 * 1.7);
        ctx.globalAlpha = a;
        ctx.font = '900 ' + fsize + 'px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        // dark stroke first (ROADMAP #17c): the +N text was vanishing against
        // the pile with no outline. Colors are untouched, only an outline is
        // added underneath the same fill.
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(2, fsize * 0.14);
        ctx.strokeStyle = 'rgba(18,12,6,0.8)';
        ctx.strokeText(p.text, p.x, p.y);
        ctx.fillStyle = p.color;
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
