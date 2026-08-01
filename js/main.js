/* Boot + game loop + camera + night sky. Global: Main */
(function () {
  'use strict';

  var canvas, ctx, DPR = 1, CW = 0, CH = 0; // CSS px
  var glass = null;
  var camera = { user: 1, panX: 0, panY: 0 };
  var spawnAcc = 0, saveAcc = 0, uiAcc = 0, gameT = 0;
  var shakeT = 0, shakeMag = 0;
  var starCanvas = null, vignette = null;
  var twinkles = [], shooting = null, shootAcc = 0;
  var dragging = false, dragX = 0, dragY = 0, didDrag = false;
  var lastTS = 0, acc = 0;
  var hintEl = null;

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
      return U.lerp(fitZoomFor(a.oldGlass), fitZoomFor(a.newGlass), a.zoomMix);
    }
    return fitZoomFor(glass) * camera.user;
  }

  // ---------- night sky ----------

  function buildStars() {
    starCanvas = document.createElement('canvas');
    starCanvas.width = Math.ceil(CW * DPR);
    starCanvas.height = Math.ceil(CH * DPR);
    var c = starCanvas.getContext('2d');
    c.scale(DPR, DPR);
    var grad = c.createLinearGradient(0, 0, 0, CH);
    grad.addColorStop(0, '#04060d');
    grad.addColorStop(0.6, '#070b16');
    grad.addColorStop(1, '#0a1020');
    c.fillStyle = grad;
    c.fillRect(0, 0, CW, CH);

    var rng = U.rng(777);
    twinkles = [];
    for (var i = 0; i < 180; i++) {
      var x = rng() * CW, y = rng() * CH * 0.9;
      var r = 0.4 + rng() * 1.5;
      var a = 0.25 + rng() * 0.6;
      c.globalAlpha = a;
      c.fillStyle = rng() < 0.25 ? '#bcd0ff' : '#e8edfa';
      c.beginPath(); c.arc(x, y, r, 0, U.TAU); c.fill();
      if (i < 9) twinkles.push({ x: x, y: y, r: r + 0.7, ph: rng() * 6 });
    }
    c.globalAlpha = 1;

    // the constellation of The Little Guy (a quiet joke for anyone who looks up)
    var cx = CW * 0.86, cy = CH * 0.6, s = CH * 0.05;
    var pts = [[0, -1.6], [-0.7, -1.1], [0.7, -1.1], [0, -0.8], [0, 0.2],
               [-0.9, -0.4], [0.9, -0.4], [-0.5, 1.2], [0.5, 1.2]];
    c.strokeStyle = 'rgba(188,208,255,0.10)';
    c.lineWidth = 1;
    var link = [[0, 3], [3, 5], [3, 6], [3, 4], [4, 7], [4, 8], [0, 1], [0, 2]];
    c.beginPath();
    for (var l = 0; l < link.length; l++) {
      c.moveTo(cx + pts[link[l][0]][0] * s, cy + pts[link[l][0]][1] * s);
      c.lineTo(cx + pts[link[l][1]][0] * s, cy + pts[link[l][1]][1] * s);
    }
    c.stroke();
    c.fillStyle = 'rgba(210,225,255,0.5)';
    for (var p2 = 0; p2 < pts.length; p2++) {
      c.beginPath();
      c.arc(cx + pts[p2][0] * s, cy + pts[p2][1] * s, 1.3, 0, U.TAU);
      c.fill();
    }

    // moon, top right
    var mx = CW * 0.9, my = CH * 0.12, mr = Math.min(CW, CH) * 0.035;
    c.fillStyle = '#d9def0';
    c.beginPath(); c.arc(mx, my, mr, 0, U.TAU); c.fill();
    c.fillStyle = '#070b16';
    c.beginPath(); c.arc(mx - mr * 0.42, my - mr * 0.18, mr * 0.86, 0, U.TAU); c.fill();
    c.globalAlpha = 0.08;
    c.fillStyle = '#d9def0';
    c.beginPath(); c.arc(mx, my, mr * 2.4, 0, U.TAU); c.fill();
    c.globalAlpha = 1;

    // dune silhouettes
    c.fillStyle = '#0a0f1e';
    c.beginPath();
    c.moveTo(0, CH);
    for (var dx = 0; dx <= CW; dx += 20) {
      c.lineTo(dx, CH - CH * 0.06 * (1 + Math.sin(dx * 0.0016 + 1.3)) - CH * 0.01);
    }
    c.lineTo(CW, CH); c.closePath(); c.fill();
    c.fillStyle = '#070b13';
    c.beginPath();
    c.moveTo(0, CH);
    for (var dx2 = 0; dx2 <= CW; dx2 += 20) {
      c.lineTo(dx2, CH - CH * 0.035 * (1 + Math.sin(dx2 * 0.003 + 4)) );
    }
    c.lineTo(CW, CH); c.closePath(); c.fill();

    // vignette
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

  // ---------- resize / input ----------

  function resize() {
    DPR = window.devicePixelRatio || 1;
    CW = window.innerWidth; CH = window.innerHeight;
    canvas.width = Math.ceil(CW * DPR);
    canvas.height = Math.ceil(CH * DPR);
    canvas.style.width = CW + 'px';
    canvas.style.height = CH + 'px';
    buildStars();
  }

  function maxUserZoom() {
    return Math.max(1.5, 70 / (CONFIG.R0 * fitZoomFor(glass)));
  }

  function wireInput() {
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (Flip.state === 'FLIPPING') return;
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

  // ---------- era / glass management ----------

  function rebuildGlass() {
    // same era, new neck (Throat Polish) — keep the pile
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
  }
  function resetCamera() { camera.user = 1; camera.panX = 0; camera.panY = 0; }

  // ---------- update / render ----------

  function update(dt) {
    gameT += dt;
    Guys.tick(dt);
    if (Flip.state !== 'FLIPPING') {
      spawnAcc += dt;
      var interval = Econ.dropInterval();
      var burst = 0;
      while (spawnAcc >= interval && burst < 6) {
        spawnAcc -= interval;
        Guys.drop(Econ.dropCount(), glass);
        burst++;
      }
      if (spawnAcc > interval * 4) spawnAcc = 0;
      Phys.step(dt, glass, gameT);
      Pile.drainStep(dt, Econ.drainRate());
      Pile.settleTick(dt);
      Society.tick(dt);
      Econ.earnPassive(dt);
    }
    Flip.tick(dt);
    FX.step(dt);

    // occasional shooting star
    shootAcc += dt;
    if (!shooting && shootAcc > 40 && Math.random() < dt / 50) {
      shootAcc = 0;
      shooting = { x: CW * (0.5 + Math.random() * 0.4), y: CH * 0.08,
                   vx: -(300 + Math.random() * 300), vy: 160, life: 1.1 };
    }
    if (shooting) {
      shooting.x += shooting.vx * dt;
      shooting.y += shooting.vy * dt;
      shooting.life -= dt;
      if (shooting.life <= 0) shooting = null;
    }
    if (shakeT > 0) shakeT -= dt;
  }

  function render() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, CW, CH);
    ctx.drawImage(starCanvas, 0, 0, CW, CH);

    // twinkles + shooting star
    for (var i = 0; i < twinkles.length; i++) {
      var t = twinkles[i];
      ctx.globalAlpha = 0.3 + 0.5 * (Math.sin(gameT * 2 + t.ph) + 1) / 2;
      ctx.fillStyle = '#f4f7ff';
      ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, U.TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (shooting) {
      var a = Math.min(1, shooting.life * 2);
      var grad = ctx.createLinearGradient(shooting.x, shooting.y,
        shooting.x - shooting.vx * 0.25, shooting.y - shooting.vy * 0.25);
      grad.addColorStop(0, 'rgba(255,255,255,' + 0.8 * a + ')');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(shooting.x, shooting.y);
      ctx.lineTo(shooting.x - shooting.vx * 0.25, shooting.y - shooting.vy * 0.25);
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
      ctx.rotate(anim.theta);
      gDraw = anim.swapped ? anim.newGlass : anim.oldGlass;
    }
    Glass.drawBack(ctx, gDraw);
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
        if (away > 90 && Flip.state !== 'FLIPPING') {
          var report = Save.processOffline({ t: hiddenAt }, Date.now());
          if (report && report.seconds > 300) UI.showAway(report);
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

    var data = devMode ? null : Save.load();
    if (data) {
      Save.apply(data);
      var report = Save.processOffline(data);
      if (report) setTimeout(function () { UI.showAway(report); }, 700);
    }
    UI.init();
    wireInput();
    wireVisibility();
    Sound.setMuted(Save.muted);
    Sound.setVolumes(Save.volumes);

    // gentle first-minute hint
    if (!data) {
      hintEl = document.createElement('div');
      hintEl.textContent = 'scroll to zoom in on the little guys · drag to pan · double-click to reset';
      hintEl.style.cssText = 'position:fixed;right:24px;bottom:18px;color:#93a0c4;' +
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
                  get gameT() { return gameT; } };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else boot();
})();
