/* Left panel, toasts, banners, modals. Global: UI */
(function () {
  'use strict';

  var els = {};
  var cards = {};   // upgrade id -> {root, btn, lvl, fill, def}
  var flipBtn = null;
  var fullEnteredAt = null; // Main.gameT when FULL state was first observed (ROADMAP #6)

  function $(id) { return document.getElementById(id); }

  function init() {
    els.sand = $('sand-amount');
    els.rate = $('sand-rate');
    els.fillPct = $('fill-pct');
    els.fillBar = $('fill-bar-inner');
    els.pop = $('pop-count');
    els.eraNum = $('era-num');
    els.eraName = $('era-name');
    els.upgrades = $('upgrades');
    els.flipSlot = $('flip-slot');

    // first-flip caption (ROADMAP #17a): a dim one-liner under the fill bar,
    // only until the player has ever flipped once. Inline-styled (no
    // stylesheet change needed) to match main.js's hintEl/hintIcon pattern.
    els.fillHint = document.createElement('div');
    els.fillHint.id = 'fill-hint';
    els.fillHint.textContent = 'Stack the sand to the red line, then FLIP.';
    els.fillHint.style.cssText = 'font-size:12px;color:var(--ink-dim);margin-top:4px;font-weight:600;';
    $('fill-block').appendChild(els.fillHint);

    rebuildUpgrades();
    refresh();

    $('btn-mute').onclick = function () {
      Save.muted = !Save.muted;
      Sound.setMuted(Save.muted);
      this.textContent = Save.muted ? '🔇' : '🔊';
      Save.save();
    };
    $('btn-mute').textContent = Save.muted ? '🔇' : '🔊';

    $('btn-export').onclick = showExport;
    $('btn-import').onclick = showImport;
    $('btn-reset').onclick = showReset;

    buildSoundSliders();
    buildSettleShake();
    buildDevMenu();
  }

  // s4 (Zach): tap the glass — a little wiggle plus the same pile "repack" a
  // Bottleneck Throttle purchase does (Main.rebuildGlass's serialize/restore
  // round-trip repaints the baked texture dense, so stray gaps click shut).
  // Purely visual medicine: volumes, counts, and economy don't move.
  function buildSettleShake() {
    var b = document.createElement('button');
    b.id = 'settle-shake';
    b.textContent = '🖐 Settle Shake';
    b.title = 'Give the glass a gentle tap — the sand settles into place.';
    b.onclick = function () {
      if (b.disabled || Flip.midFlip()) return;
      b.disabled = true;
      Main.shake(0.5);
      Main.rebuildGlass();
      if (window.Sound) Sound.pop();
      setTimeout(function () { b.disabled = false; }, 2500);
    };
    document.body.appendChild(b);
  }

  var saveDebounce = null;
  function buildSoundSliders() {
    var rows = document.createElement('div');
    rows.id = 'sound-rows';
    var defs = [
      ['music', '🎵', 'Music'],
      ['donk',  '🥁', 'Donks'],   // sandmen hitting things
      ['ping',  '🔔', 'Pings']    // upgrade chimes + fanfares
    ];
    defs.forEach(function (d) {
      var row = document.createElement('div');
      row.className = 'snd-row';
      var label = document.createElement('span');
      label.className = 'snd-label';
      label.textContent = d[1] + ' ' + d[2];
      var slider = document.createElement('input');
      slider.type = 'range';
      slider.min = 0; slider.max = 100;
      slider.value = Math.round(Save.volumes[d[0]] * 100);
      slider.oninput = function () {
        Save.volumes[d[0]] = slider.value / 100;
        Sound.setVolumes(Save.volumes);
        clearTimeout(saveDebounce);
        saveDebounce = setTimeout(function () { Save.save(); }, 800);
      };
      row.appendChild(label);
      row.appendChild(slider);
      rows.appendChild(row);
    });
    var foot = $('panel-foot');
    foot.parentNode.insertBefore(rows, foot);
  }

  // ---------- upgrades ----------

  var GROUPS = [
    { key: undefined,   title: 'FOUNDATION' },
    { key: 'society',   title: 'THE SOCIETY' },
    { key: 'glass',     title: 'GLASSWORK' }
  ];

  function rebuildUpgrades() {
    els.upgrades.innerHTML = '';
    cards = {};
    var visible = Econ.visibleUpgrades();
    for (var g = 0; g < GROUPS.length; g++) {
      var group = GROUPS[g];
      var mine = visible.filter(function (u) { return u.branch === group.key; });
      if (!mine.length) continue;
      var title = document.createElement('div');
      title.className = 'upg-group-title';
      title.textContent = group.title;
      els.upgrades.appendChild(title);
      for (var i = 0; i < mine.length; i++) addCard(mine[i]);
    }
  }

  function addCard(u) {
    var card = document.createElement('div');
    card.className = 'upg-card';
    card.innerHTML =
      '<div class="upg-icon">' + u.icon + '</div>' +
      '<div class="upg-mid">' +
        '<div class="upg-name">' + u.name + '<span class="lvl"></span></div>' +
        '<div class="upg-desc">' + u.desc + '</div>' +
      '</div>' +
      '<button class="upg-buy"></button>' +
      '<div class="upg-maxed-pill">MAXED</div>' +
      '<div class="upg-fill"><div class="upg-fill-inner"></div></div>';
    var btn = card.querySelector('.upg-buy');
    btn.onclick = function () {
      if (Econ.buy(u.id)) {
        refresh();
        // buy feedback (ROADMAP #4d): scale-pulse + gold flash, restarted
        // even on a rapid re-buy via a reflow between remove and re-add
        card.classList.remove('upg-bought');
        void card.offsetWidth;
        card.classList.add('upg-bought');
        setTimeout(function () { card.classList.remove('upg-bought'); }, 450);
      }
    };
    els.upgrades.appendChild(card);
    cards[u.id] = { root: card, btn: btn, lvl: card.querySelector('.lvl'),
                    fill: card.querySelector('.upg-fill-inner'), def: u };
  }

  // ---------- upgrade tooltips (ROADMAP #4a) ----------
  // Read-only preview: computes "now" and "next level" from the SAME getters
  // the game itself uses (economy.js's six parameterized derived rates), or —
  // for effects that live in js/society.js (builders/stackers) or js/save.js
  // (watch) — mirrors that exact formula here for display only. Nothing here
  // ever mutates Econ.levels or calls into another module's internals.
  function fmtPct(x, dp) { return (x * 100).toFixed(dp == null ? 1 : dp) + '%'; }
  function fmtX(x) { return '×' + x.toFixed(2); }

  // mirrors js/society.js maxStructures()/buildSpeed()/workerTarget()
  function builderPreview(l) {
    var era = Econ.era;
    var maxS = Math.max(0, Math.min(10, 1 + Math.floor(l / 2) + Math.min(3, era - 2)));
    var spd = 1 / (26 / (1 + l * 0.35));
    var workers = Math.max(0, Math.min(14, 3 + l + (era - 2)));
    return maxS + ' structures, ' + workers + ' workers, ' + spd.toFixed(2) + ' build/s';
  }
  // mirrors js/society.js's pyramid size formula (n = min(5, 2 + floor(lvl/2)))
  function stackerPreview(l) {
    return 'pyramids up to ' + Math.min(5, 2 + Math.floor(l / 2)) + ' guys';
  }
  // mirrors js/save.js processOffline()'s Night Watchmen read
  function watchPreview(l) {
    var capH = CONFIG.OFFLINE_CAP_HOURS + l * CONFIG.WATCH_HOURS_PER_LVL;
    var eff = Math.min(1, CONFIG.OFFLINE_EFF + l * CONFIG.WATCH_EFF_PER_LVL);
    return capH.toFixed(1) + 'h offline cap, ' + fmtPct(eff) + ' efficiency';
  }

  function effectNow(id, l) {
    switch (id) {
      case 'rate':     return Econ.dropInterval(l).toFixed(2) + 's between drops';
      case 'size':     return '+' + fmtPct(Econ.sizeMult(l) - 1) + ' size/value';
      case 'multi':    return (1 + l) + ' sandm' + (1 + l === 1 ? 'an' : 'en') + ' per drop';
      case 'colors':   return Math.min(START_COLORS + l, PALETTE.length) +
                              ' colors, +' + fmtPct(CONFIG.VARIETY_BONUS * l) + ' sand';
      case 'builders': return builderPreview(l);
      case 'stackers': return stackerPreview(l);
      case 'bards':    return '+' + fmtPct(Econ.bardMult(l) - 1) + ' all income';
      case 'neck':     return fmtX(Econ.neckMult(l)) + ' neck flow';
      case 'gold':     return fmtPct(Econ.goldChance(l), 2) + ' gold chance';
      case 'deep':     return '+' + fmtPct(Econ.deepMult(l) - 1) + ' all income';
      case 'watch':    return watchPreview(l);
      default:         return null;
    }
  }
  function effectTooltip(u) {
    var l = Econ.lvl(u.id), maxed = Econ.isMaxed(u.id);
    var now = effectNow(u.id, l);
    if (now == null) return u.name; // no known formula — plain fallback
    if (maxed) return u.name + '\nNow: ' + now + ' (max level)';
    return u.name + '\nNow: ' + now + '\nNext (Lv ' + (l + 1) + '): ' + effectNow(u.id, l + 1);
  }

  function refresh() {
    els.sand.textContent = U.fmt(Econ.sand);
    els.rate.textContent = '+' + U.fmt(Econ.totalRate()) + ' /s';
    var fill = Pile.fillFraction();
    var fillClamped = Math.min(1, fill);
    els.fillPct.textContent = Math.min(100, Math.floor(fill * 100)) + '%';
    els.fillBar.style.width = Math.min(100, fill * 100) + '%';
    els.pop.textContent = U.fmt(Econ.population());
    els.eraNum.textContent = 'Era ' + Econ.era;
    els.eraName.textContent = Econ.eraName(Econ.era);

    // tension ramp (ROADMAP #6): a continuous 0..1 var for CSS to read, plus
    // discrete thresholds for the intensified bar (~70%) and the pulsing
    // percentage text (~90%)
    document.documentElement.style.setProperty('--fill-frac', fillClamped.toFixed(3));
    els.fillBar.classList.toggle('fill-tense', fill >= 0.7);
    els.fillPct.classList.toggle('pct-urgent', fill >= 0.9);

    // first-flip caption (ROADMAP #17a): gone for good after the first flip
    if (els.fillHint) els.fillHint.style.display = Econ.counts.flips > 0 ? 'none' : 'block';

    // FLIP button urgency ramp (ROADMAP #6, the buildable beyond the roadmap
    // item): tracked locally via Main.gameT rather than reading js/flip.js's
    // internal fullTimer, so this stays inside ui.js/main.js's item scope.
    if (Flip.state === 'FULL') {
      if (fullEnteredAt == null) fullEnteredAt = Main.gameT;
    } else {
      fullEnteredAt = null;
    }
    if (flipBtn) {
      var openFrac = fullEnteredAt != null
        ? U.clamp((Main.gameT - fullEnteredAt) / CONFIG.FLIP_AUTO_SECONDS, 0, 1) : 0;
      flipBtn.style.animationDuration = U.lerp(0.9, 0.3, openFrac).toFixed(2) + 's';
    }

    for (var id in cards) {
      var c = cards[id];
      var maxed = Econ.isMaxed(id);
      c.lvl.textContent = Econ.lvl(id) > 0 ? ' Lv ' + Econ.lvl(id) : '';
      c.root.classList.toggle('maxed', maxed);
      c.root.title = effectTooltip(c.def);
      if (!maxed) {
        var cost = Econ.costOf(id);
        var afford = Econ.canBuy(id);
        c.btn.textContent = U.fmt(cost);
        c.btn.disabled = !afford;
        // progress fill (ROADMAP #4b): only meaningful — and only shown —
        // while the card is genuinely unaffordable
        c.root.classList.toggle('unaffordable', !afford);
        c.fill.style.width = Math.max(0, Math.min(100, (Econ.sand / cost) * 100)) + '%';
      } else {
        c.root.classList.remove('unaffordable');
      }
    }
  }

  // ---------- flip button ----------

  function showFlipButton(cb) {
    if (flipBtn) return;
    flipBtn = document.createElement('button');
    flipBtn.id = 'flip-btn';
    flipBtn.textContent = 'FLIP!';
    flipBtn.onclick = cb;
    els.flipSlot.appendChild(flipBtn);
  }
  function hideFlipButton() {
    if (flipBtn) { flipBtn.remove(); flipBtn = null; }
  }

  // ---------- banners / toasts ----------

  function banner(big, small) {
    var root = $('banner-root');
    var el = document.createElement('div');
    el.className = 'era-banner';
    el.innerHTML = '<div class="big"></div><div class="small"></div>';
    el.querySelector('.big').textContent = big;
    el.querySelector('.small').textContent = small;
    root.appendChild(el);
    setTimeout(function () { el.remove(); }, 3800);
  }

  function toast(title, body) {
    var root = $('toast-root');
    while (root.children.length >= 3) root.firstChild.remove();
    var el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = '<div class="t-title"></div><div class="t-body"></div>';
    el.querySelector('.t-title').textContent = title;
    el.querySelector('.t-body').textContent = body;
    root.appendChild(el);
    setTimeout(function () { el.remove(); }, 6200);
  }

  // ---------- modals ----------

  function modal(html) {
    var root = $('modal-root');
    root.innerHTML = '';
    var m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = html;
    root.appendChild(m);
    return m;
  }
  function closeModal() { $('modal-root').innerHTML = ''; }

  function showAway(report) {
    var lines = [];
    lines.push('<p>☔ <b>' + U.fmt(report.guys) + '</b> sandmen arrived and settled in.</p>');
    if (report.atomized > 0) {
      lines.push('<p>⛰️ <b>' + U.fmt(report.atomized) + '</b> more came down from the old ' +
                 'mountain. It is smaller than you left it.</p>');
    }
    lines.push('<p>💰 The society banked <b>' + U.fmt(report.sand) + '</b> sand.</p>');
    // offline honesty (ROADMAP #14a): the plain truth when the away window
    // ran past the cap — no stat dump, just one line in the modal's own voice
    if (report.capped) lines.push('<p class="dim">…and then the sky forgot to count further.</p>');
    if (report.full) lines.push('<p>⏳ <b>The chamber filled while you were gone.</b> They are waiting. They don\'t know for what.</p>');
    else lines.push('<p class="dim">The little guys kept at it. Nobody discusses the sky.</p>');
    var m = modal(
      '<h2>While you were away (' + U.fmtTime(report.seconds) + ')</h2>' +
      lines.join('') +
      '<div class="modal-btns"><button id="m-ok">Back to work</button></div>');
    m.querySelector('#m-ok').onclick = closeModal;
  }

  function showExport() {
    if (Flip.midFlip()) { toast('Hold on', 'The glass is mid-flip — try Export again in a second.'); return; }
    var str = Save.exportString();
    var m = modal(
      '<h2>Export save</h2>' +
      '<p class="dim">Copy this somewhere safe. Paste it back with Import to restore.</p>' +
      '<textarea readonly></textarea>' +
      '<div class="modal-btns"><button id="m-copy">Copy</button>' +
      '<button class="ghost" id="m-close">Close</button></div>');
    var ta = m.querySelector('textarea');
    ta.value = str;
    m.querySelector('#m-copy').onclick = function () {
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      this.textContent = 'Copied!';
    };
    m.querySelector('#m-close').onclick = closeModal;
  }

  function showImport() {
    var m = modal(
      '<h2>Import save</h2>' +
      '<p class="dim">Paste an exported save below. This replaces your current game.</p>' +
      '<textarea placeholder="OG1.…"></textarea>' +
      '<p class="dim" id="m-err" style="color:#ff8a8a"></p>' +
      '<div class="modal-btns"><button id="m-load">Load it</button>' +
      '<button class="ghost" id="m-close">Cancel</button></div>');
    m.querySelector('#m-load').onclick = function () {
      var err = Save.importString(m.querySelector('textarea').value);
      if (err) m.querySelector('#m-err').textContent = err;
    };
    m.querySelector('#m-close').onclick = closeModal;
  }

  function showReset() {
    var m = modal(
      '<h2>Start over?</h2>' +
      '<p>This wipes the glass, the sand, and the entire civilization. ' +
      'They would want you to know they were happy here.</p>' +
      '<p class="dim">Export a backup first? ' +
      '<a href="#" id="m-export-link" style="color:var(--sand);text-decoration:underline;cursor:pointer;">Export now</a></p>' +
      '<div class="modal-btns"><button class="ghost" id="m-yes">Wipe it all</button>' +
      '<button id="m-no">Keep playing</button></div>');
    m.querySelector('#m-yes').onclick = function () { Save.reset(); };
    m.querySelector('#m-no').onclick = closeModal;
    m.querySelector('#m-export-link').onclick = function (e) { e.preventDefault(); showExport(); };
  }

  // ---------- dev tools menu (?dev=1 only) ----------
  // Invisible and inert without the flag: no DOM, no listeners, nothing runs.
  // A sibling appended AFTER #panel-foot (not inside #upgrades, which
  // rebuildUpgrades() wipes on every era flip) so it survives flips and sits
  // at the literal bottom of the sidebar without touching the panel's
  // existing flex/scroll layout.
  function buildDevMenu() {
    if (!/[?&]dev=1/.test(location.search)) return;

    var wrap = document.createElement('div');
    wrap.id = 'dev-menu';

    var toggle = document.createElement('div');
    toggle.id = 'dev-toggle';
    toggle.textContent = 'DEV ▾';
    wrap.appendChild(toggle);

    var body = document.createElement('div');
    body.id = 'dev-body';
    body.style.display = 'none';
    wrap.appendChild(body);

    toggle.onclick = function () {
      var opening = body.style.display === 'none';
      body.style.display = opening ? 'block' : 'none';
      toggle.textContent = 'DEV ' + (opening ? '▴' : '▾');
    };

    // WARP TO ERA — reuses test/selftest.js's own warp machinery by simply
    // navigating there; no second implementation of the fast-forward logic.
    var warpGroup = document.createElement('div');
    warpGroup.className = 'dev-group';
    warpGroup.innerHTML = '<div class="dev-label">WARP TO ERA</div>';
    var warpRow = document.createElement('div');
    warpRow.className = 'dev-row';
    for (var e = 1; e <= 10; e++) {
      var wb = document.createElement('button');
      wb.className = 'dev-btn dev-btn-sm';
      wb.textContent = e;
      wb.dataset.era = e;
      wb.onclick = (function (era) { return function () { confirmWarp(era); }; })(e);
      warpRow.appendChild(wb);
    }
    warpGroup.appendChild(warpRow);
    body.appendChild(warpGroup);

    // SAND AWARD — the same two-line mutation Econ.earnPassive() already
    // uses (sand + totalEarned only): no counts/pile side effects.
    var sandGroup = document.createElement('div');
    sandGroup.className = 'dev-group';
    sandGroup.innerHTML = '<div class="dev-label">SAND AWARD</div>';
    var sandRow = document.createElement('div');
    sandRow.className = 'dev-row';
    [[1000, '+1K'], [100000, '+100K'], [10000000, '+10M']].forEach(function (pair) {
      var sb = document.createElement('button');
      sb.className = 'dev-btn';
      sb.dataset.amount = pair[0];
      sb.textContent = pair[1];
      sb.onclick = function () { awardSand(pair[0]); };
      sandRow.appendChild(sb);
    });
    sandGroup.appendChild(sandRow);
    body.appendChild(sandGroup);

    // FILL TO 95% — routes through Pile.devFillTo(), which pours real
    // volume+count+sand through the same paths a bake uses.
    var fillGroup = document.createElement('div');
    fillGroup.className = 'dev-group';
    var fb = document.createElement('button');
    fb.id = 'dev-fill-btn';
    fb.className = 'dev-btn dev-btn-wide';
    fb.textContent = 'FILL TO 95%';
    fb.onclick = fillTo95;
    fillGroup.appendChild(fb);
    body.appendChild(fillGroup);

    $('panel-foot').parentNode.appendChild(wrap);
  }

  function confirmWarp(era) {
    var m = modal(
      '<h2>Warp to Era ' + era + '?</h2>' +
      '<p>This replaces your current progress with a fresh game, fast-forwarded ' +
      'to Era ' + era + '. Dev only — nothing here is saved.</p>' +
      '<div class="modal-btns"><button class="ghost" id="m-no">Cancel</button>' +
      '<button id="m-yes">Warp</button></div>');
    m.querySelector('#m-yes').onclick = function () {
      location.href = '?dev=1&warp=' + era;
    };
    m.querySelector('#m-no').onclick = closeModal;
  }

  function awardSand(amount) {
    Econ.sand += amount;
    Econ.totalEarned += amount;
    refresh();
    toast('DEV', '+' + U.fmt(amount) + ' sand awarded.');
  }

  function fillTo95() {
    var n = Pile.devFillTo(0.95);
    refresh();
    toast('DEV', n > 0
      ? 'Poured ' + U.fmt(n) + ' guys into the pile — 95% full.'
      : 'Already at or above 95% full.');
  }

  window.UI = { init: init, refresh: refresh, rebuildUpgrades: rebuildUpgrades,
                showFlipButton: showFlipButton, hideFlipButton: hideFlipButton,
                banner: banner, toast: toast, showAway: showAway,
                closeModal: closeModal };
})();
