/* THE FLIP — the game's biggest moment. State machine + cinematic timing.
   Global: Flip */
(function () {
  'use strict';

  var state = 'NORMAL';        // NORMAL | FULL | FLIPPING
  var fullTimer = 0;
  var anim = null;             // {t, oldGlass, newGlass}
  var confettiAcc = 0;

  function tick(dt) {
    if (state === 'NORMAL') {
      if (Pile.fillFraction() >= 1) enterFull();
    } else if (state === 'FULL') {
      fullTimer += dt;
      if (fullTimer >= CONFIG.FLIP_AUTO_SECONDS) doFlip();
    } else if (state === 'FLIPPING') {
      anim.t += dt / CONFIG.FLIP_ANIM_SECONDS;
      confettiAcc += dt;
      if (confettiAcc > 0.35 && anim.t < 0.8) {
        confettiAcc = 0;
        FX.confettiBurst(Math.random() * innerWidth, innerHeight * (0.2 + Math.random() * 0.3), 26);
      }
      if (anim.t >= 1) finish();
    }
  }

  function enterFull() {
    state = 'FULL';
    fullTimer = 0;
    if (window.Sound) Sound.klaxon();
    UI.showFlipButton(doFlip);
  }

  function doFlip() {
    if (state !== 'FULL') return;
    UI.hideFlipButton();
    var oldGlass = Main.glassRef();
    var newGlass = Glass.build(Econ.era + 1, Econ.neckMult());
    anim = { t: 0, oldGlass: oldGlass, newGlass: newGlass };
    state = 'FLIPPING';
    confettiAcc = 0;
    Main.resetCamera();
    // the works come crashing down (the guys are FINE — they are the sand)
    Society.flipDestroy();
    Main.shake(1.2);
    if (window.Sound) Sound.fanfare();
    FX.confettiBurst(innerWidth / 2, innerHeight / 2, 80);
  }

  function finish() {
    Econ.era++;
    Econ.counts.flips++;
    Phys.rotateAll();
    Pile.flipToTop(anim.newGlass);
    Main.onEraChanged(anim.newGlass);
    Society.reset();
    if (window.Sound) Sound.boom();
    Main.shake(1.6);

    var name = Econ.eraName(Econ.era);
    UI.banner('ERA ' + Econ.era, name);
    var eraDef = ERAS[Econ.era - 1];
    if (eraDef && eraDef.card) {
      setTimeout(function () { UI.toast(eraDef.card[0], eraDef.card[1]); }, 2200);
    }
    UI.rebuildUpgrades();
    state = 'NORMAL';
    anim = null;
    Save.save();
  }

  // 0..1 eased progress for the renderer
  function animState() {
    if (state !== 'FLIPPING' || !anim) return null;
    var e = U.easeInOutCubic(Math.min(1, anim.t));
    return {
      theta: Math.PI * e,
      zoomMix: e,
      oldGlass: anim.oldGlass,
      newGlass: anim.newGlass,
      swapped: anim.t > 0.55
    };
  }

  window.Flip = {
    tick: tick, doFlip: doFlip, animState: animState,
    get state() { return state; },
    forceFull: enterFull   // used by the selftest
  };
})();
