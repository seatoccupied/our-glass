/* The Doomsayer-cam: a small, always-dark inset window that appears while
   the prophet is on stage — a second, zoomed render pass whose camera is
   locked to HIS exact drawn position (js/society.js stashes it on the
   doomsayer object each frame). Centering on him every frame cancels his own
   position/bob so he reads rock-steady while everything else in frame (sand,
   workers, structures) keeps moving normally around him.

   Fully self-driving: its own <canvas>, own requestAnimationFrame loop, own
   inline styles. Read-only — it never calls anything that mutates game
   state, and it costs nothing while the Doomsayer isn't around (one cheap
   getter check per frame). Global: DoomCam */
(function () {
  'use strict';

  var SIZE = 280;          // ✏️ TUNE inset size, CSS px
  var TARGET_DOOM_PX = 30; // ✏️ TUNE his on-screen body radius inside the inset
  var TARGET_NEARBY_PX = 130; // ✏️ TUNE half-width of the "nearby" window, screen px

  // society.js scales the whole cast (him included) off the glass's capacity
  // growth so it reads at a constant SCREEN size at the game's default zoom
  // (ROADMAP #7) — his WORLD-unit radius is therefore ~10 at era 1 and ~120+
  // by era 6. A fixed inset zoom would frame him fine at era 1 and have him
  // overflow the whole inset by era 6 (his circle alone bigger than SIZE).
  // So the inset's own zoom is derived from Society.castR() every frame,
  // the same "cancel the growth" trick castR() itself uses — he ends up the
  // same on-screen size in the inset at every era, by construction.

  var canvas = null, ctx = null, visible = false, dpr = 1;

  function ensureDom() {
    if (canvas) return;
    dpr = window.devicePixelRatio || 1;
    canvas = document.createElement('canvas');
    canvas.id = 'doomcam';
    canvas.width = Math.ceil(SIZE * dpr);
    canvas.height = Math.ceil(SIZE * dpr);
    canvas.style.cssText =
      'position:fixed;right:24px;bottom:24px;' +
      'width:' + SIZE + 'px;height:' + SIZE + 'px;' +
      'border-radius:16px;border:3px solid #2a3560;' +
      'box-shadow:0 0 0 3px #070b16,0 10px 34px rgba(0,0,0,0.65),0 0 44px rgba(255,196,110,0.10);' +
      'background:#04060d;z-index:30;pointer-events:none;' +
      'opacity:0;transition:opacity 0.4s ease;';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
  }

  function show() {
    ensureDom();
    if (!visible) { visible = true; canvas.style.opacity = '1'; }
  }
  function hide() {
    if (canvas && visible) canvas.style.opacity = '0';
    visible = false;
  }

  function roundRectPath(c, x, y, w, h, r) {
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function render() {
    if (!window.Society || !window.Pile) return;
    var d = Society.doomsayerRef;
    if (!d) { hide(); return; }
    show();
    if (!ctx) return;

    var camX = d.camX, camY = d.camY;
    // first frame he exists, render() in society.js hasn't stashed a center
    // yet — fall back to his base position so nothing jumps once it does
    if (camY == null) { camX = d.x; camY = Pile.surfaceAt(d.x) - CONFIG.R0; }

    var castR = (window.Society.castR ? Society.castR() : CONFIG.R0) || CONFIG.R0;
    var ZOOM = TARGET_DOOM_PX / castR;
    var NEARBY = TARGET_NEARBY_PX / ZOOM;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = '#04060d';
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.save();
    ctx.beginPath();
    roundRectPath(ctx, 0, 0, SIZE, SIZE, 13);
    ctx.clip();

    // a dark backdrop tint before the world — this is a close-up, not the sky
    ctx.fillStyle = '#0a1020';
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.translate(SIZE / 2, SIZE / 2);
    ctx.scale(ZOOM, ZOOM);
    ctx.translate(-camX, -camY);

    // A local silhouette of the sand surface, built from Pile.surfaceAt() —
    // a pure query, not js/pile.js's own render() (which we deliberately
    // never call here: it drives module-level animation state — glintT — and
    // calling it a second time per frame would double-speed the MAIN scene's
    // twinkles for as long as this inset is open. This stays read-only.
    var steps = 22, spanX = camX - NEARBY, spanX2 = camX + NEARBY, floorY = camY + NEARBY * 2.2;
    ctx.beginPath();
    ctx.moveTo(spanX, floorY);
    for (var sx = 0; sx <= steps; sx++) {
      var wx = spanX + (spanX2 - spanX) * sx / steps;
      ctx.lineTo(wx, Pile.surfaceAt(wx));
    }
    ctx.lineTo(spanX2, floorY);
    ctx.closePath();
    var sandGrad = ctx.createLinearGradient(0, camY - NEARBY, 0, camY + NEARBY);
    sandGrad.addColorStop(0, '#3a2c1c');
    sandGrad.addColorStop(1, '#181008');
    ctx.fillStyle = sandGrad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,26,48,0.7)';
    ctx.lineWidth = 3 / ZOOM;
    ctx.stroke();

    // nearby live guys only — bounded cost no matter how crowded the glass is
    if (window.Phys && window.Guys) {
      var bodies = Phys.bodies, drawn = 0;
      for (var i = 0; i < bodies.length && drawn < 40; i++) {
        var b = bodies[i];
        if (Math.abs(b.x - camX) > NEARBY || Math.abs(b.y - camY) > NEARBY) continue;
        Guys.drawGuy(ctx, b, ZOOM, !b.grounded && Math.abs(b.vy) > 60);
        drawn++;
      }
    }

    // structures + workers + the Doomsayer himself, at the SAME world
    // coordinates — reusing this is what makes "the world sways behind him"
    // free: he's centered by construction, everyone else isn't
    Society.render(ctx, ZOOM);

    ctx.restore(); // clip
    ctx.restore(); // outer

    // caption
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(4,6,13,0.82)';
    ctx.fillRect(0, SIZE - 24, SIZE, 24);
    ctx.fillStyle = '#93a0c4';
    ctx.font = '800 11px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.letterSpacing = '1px';
    ctx.fillText('THE PROPHET', SIZE / 2, SIZE - 8);
    ctx.restore();
  }

  function loop() {
    requestAnimationFrame(loop);
    render();
  }
  requestAnimationFrame(loop);

  window.DoomCam = { render: render };
})();
