/* Left panel, toasts, banners, modals. Global: UI */
(function () {
  'use strict';

  var els = {};
  var cards = {};   // upgrade id -> {root, buyBtn, lvlEl}
  var flipBtn = null;

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
      '<button class="upg-buy"></button>';
    var btn = card.querySelector('.upg-buy');
    btn.onclick = function () {
      if (Econ.buy(u.id)) refresh();
    };
    els.upgrades.appendChild(card);
    cards[u.id] = { root: card, btn: btn, lvl: card.querySelector('.lvl') };
  }

  function refresh() {
    els.sand.textContent = U.fmt(Econ.sand);
    els.rate.textContent = '+' + U.fmt(Econ.totalRate()) + ' /s';
    var fill = Pile.fillFraction();
    els.fillPct.textContent = Math.min(100, Math.floor(fill * 100)) + '%';
    els.fillBar.style.width = Math.min(100, fill * 100) + '%';
    els.pop.textContent = U.fmt(Econ.population());
    els.eraNum.textContent = 'Era ' + Econ.era;
    els.eraName.textContent = Econ.eraName(Econ.era);

    for (var id in cards) {
      var c = cards[id];
      var maxed = Econ.isMaxed(id);
      c.lvl.textContent = Econ.lvl(id) > 0 ? ' Lv ' + Econ.lvl(id) : '';
      c.root.classList.toggle('maxed', maxed);
      if (!maxed) {
        c.btn.textContent = U.fmt(Econ.costOf(id));
        c.btn.disabled = !Econ.canBuy(id);
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
    lines.push('<p>💰 The society banked <b>' + U.fmt(report.sand) + '</b> sand.</p>');
    if (report.full) lines.push('<p>⏳ <b>The chamber filled while you were gone.</b> They are waiting. They don\'t know for what.</p>');
    else lines.push('<p class="dim">The little guys kept at it. Nobody discusses the sky.</p>');
    var m = modal(
      '<h2>While you were away (' + U.fmtTime(report.seconds) + ')</h2>' +
      lines.join('') +
      '<div class="modal-btns"><button id="m-ok">Back to work</button></div>');
    m.querySelector('#m-ok').onclick = closeModal;
  }

  function showExport() {
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
      '<div class="modal-btns"><button class="ghost" id="m-yes">Wipe it all</button>' +
      '<button id="m-no">Keep playing</button></div>');
    m.querySelector('#m-yes').onclick = function () { Save.reset(); };
    m.querySelector('#m-no').onclick = closeModal;
  }

  window.UI = { init: init, refresh: refresh, rebuildUpgrades: rebuildUpgrades,
                showFlipButton: showFlipButton, hideFlipButton: hideFlipButton,
                banner: banner, toast: toast, showAway: showAway,
                closeModal: closeModal };
})();
