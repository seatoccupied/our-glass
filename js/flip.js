/* THE FLIP — the game's biggest moment. State machine + cinematic timing.
   Global: Flip

   Three staged beats, not one dissolve:
     0. ROTATING — the sim freezes and the WHOLE world (glass, piles,
        structures, live guys) turns 180° around the glass centre under
        main.js's camera transform. The data swap happens at the very end.
     1. CRUSHING — the old bottom pile is now upside down above everyone. It
        falls onto the funnel and avalanches flat (js/pile.js crushTick), and
        the buildings are destroyed DURING that collapse, buried one at a time
        by their own pile (js/society.js crushTick). The camera eases out to
        the new, larger era scale over the same window.
     2. atomization — not a flip state at all: the game is back to NORMAL and
        the settled mass streams back out through the neck as little guys over
        the first tenth of the era (js/pile.js drainStep).
   The old beats all survive around this: klaxon, shake, confetti, fanfare,
   landing boom, era banner, unlock toast. */
(function () {
  'use strict';

  var state = 'NORMAL';        // NORMAL | FULL | ROTATING | CRUSHING
  var fullTimer = 0;
  var anim = null;             // {t, oldGlass, newGlass}
  var confettiAcc = 0;

  function midFlip() { return state === 'ROTATING' || state === 'CRUSHING'; }
  function frozen() { return state === 'ROTATING'; } // the only sim-freeze window

  function tick(dt) {
    if (state === 'NORMAL') {
      if (Pile.fillFraction() >= 1) enterFull();
    } else if (state === 'FULL') {
      fullTimer += dt;
      // s4 (Zach): NO auto-flip — the flip is the player's best moment and
      // nobody takes it from them. The rain pauses at FULL (main.js) and the
      // world waits, klaxon sung, button pulsing, for as long as it takes.
    } else if (state === 'ROTATING') {
      anim.t += dt / CONFIG.FLIP_ROTATE_SECONDS;
      confettiAcc += dt;
      if (confettiAcc > 0.3 && anim.t < 0.85) {
        confettiAcc = 0;
        FX.confettiBurst(Math.random() * innerWidth, innerHeight * (0.2 + Math.random() * 0.3), 26);
      }
      if (anim.t >= 1) land();
    } else if (state === 'CRUSHING') {
      anim.t += dt / CONFIG.FLIP_CRUSH_SECONDS;
      Pile.crushTick(dt);
      Society.crushTick(dt);
      if (anim.t >= 1) settle();
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
    state = 'ROTATING';
    confettiAcc = 0;
    Main.resetCamera();
    Main.shake(1.2);
    if (window.Sound) Sound.fanfare();
    FX.confettiBurst(innerWidth / 2, innerHeight / 2, 80);
  }

  // rotation over: the world is upside down, so swap the data to match.
  function land() {
    var oldGlass = anim.oldGlass, newGlass = anim.newGlass;
    var scale = newGlass.bulbHW / oldGlass.bulbHW;
    Econ.era++;
    Econ.counts.flips++;
    if (window.Sound) Sound.setEra(Econ.era);
    Phys.rotateAll();
    Pile.flipToTop(newGlass, oldGlass);
    Main.onEraChanged(newGlass);
    // the works are doomed but not gone yet — they ride the inverted pile down
    // and get buried by it, one at a time, during the crush
    Society.flipDoom(function (x) { return -x * scale; }, CONFIG.FLIP_CRUSH_SECONDS);
    if (window.Sound) Sound.boom();
    Main.shake(1.6);

    var name = Econ.eraName(Econ.era);
    UI.banner('ERA ' + Econ.era, name);
    var eraDef = ERAS[Econ.era - 1];
    if (eraDef && eraDef.card) {
      setTimeout(function () { UI.toast(eraDef.card[0], eraDef.card[1]); }, 2200);
    }
    UI.rebuildUpgrades();
    anim.t = 0;
    state = 'CRUSHING';
  }

  // the mass has landed and settled — hand back to normal play, and the
  // atomization stream (started inside Pile.crushTick's crushEnd) takes over
  function settle() {
    // crushTick above shares this exact window, so it has normally already
    // closed the collapse out and started the stream. This is the guarantee:
    // the mass is DOWN and pouring by the time play resumes, whatever dt did.
    Pile.crushFinish();
    Society.reset();
    Main.shake(0.5);
    state = 'NORMAL';
    anim = null;
    Save.save();
  }

  // what the renderer needs: which glass to draw, how far the world is turned,
  // and how far along the zoom-out to the new era scale is
  function animState() {
    if (!anim) return null;
    var e = U.easeInOutCubic(Math.min(1, anim.t));
    if (state === 'ROTATING') {
      return { theta: Math.PI * e, zoomMix: 0, glass: anim.oldGlass,
               oldGlass: anim.oldGlass, newGlass: anim.newGlass };
    }
    return { theta: 0, zoomMix: e, glass: anim.newGlass,
             oldGlass: anim.oldGlass, newGlass: anim.newGlass };
  }

  window.Flip = {
    tick: tick, doFlip: doFlip, animState: animState,
    midFlip: midFlip, frozen: frozen,
    get state() { return state; },
    get totalSeconds() { return CONFIG.FLIP_ROTATE_SECONDS + CONFIG.FLIP_CRUSH_SECONDS; },
    forceFull: enterFull   // used by the selftest
  };
})();
