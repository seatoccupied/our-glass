/* All-procedural WebAudio: a chill lo-fi bed, plinks, pops, and the flip
   fanfare. No audio files anywhere. Global: Sound */
(function () {
  'use strict';

  var ctx = null, master = null, musicGain = null, delaySend = null;
  var donkGain = null, pingGain = null;
  var muted = false;
  var vols = { music: 1, donk: 1, ping: 1 };
  var nextChordAt = 0, chordIdx = 0, nextPluckAt = 0;
  var plinkTimes = [];

  function midi(n) { return 440 * Math.pow(2, (n - 69) / 12); }

  // Am7 – Fmaj7 – Cmaj7 – G7, low and warm
  var CHORDS = [
    [45, 52, 55, 60, 64],
    [41, 48, 53, 57, 60],
    [36, 48, 52, 55, 59],
    [43, 50, 55, 59, 62]
  ];
  var PENTA = [69, 72, 74, 76, 79, 81, 84];

  function ensure() {
    if (ctx) return true;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.85;
      master.connect(ctx.destination);

      musicGain = ctx.createGain();
      musicGain.connect(master);
      donkGain = ctx.createGain();   // sandmen hitting things
      donkGain.connect(master);
      pingGain = ctx.createGain();   // upgrade chimes + fanfares
      pingGain.connect(master);
      applyVolumes();

      // a soft echo for plucks — instant lo-fi space
      delaySend = ctx.createGain();
      delaySend.gain.value = 0.9;
      var delay = ctx.createDelay(1.0);
      delay.delayTime.value = 0.34;
      var fb = ctx.createGain();
      fb.gain.value = 0.3;
      var dl = ctx.createBiquadFilter();
      dl.type = 'lowpass'; dl.frequency.value = 1200;
      delaySend.connect(delay);
      delay.connect(dl); dl.connect(fb); fb.connect(delay);
      dl.connect(musicGain);

      startCrackle();
      nextChordAt = ctx.currentTime + 0.2;
      nextPluckAt = ctx.currentTime + 4;
      setInterval(schedule, 400);
      return true;
    } catch (e) { return false; }
  }

  function schedule() {
    if (!ctx) return;
    var now = ctx.currentTime;
    while (nextChordAt < now + 1.2) {
      playChord(CHORDS[chordIdx % CHORDS.length], nextChordAt);
      chordIdx++;
      nextChordAt += 8;
    }
    if (nextPluckAt < now + 1.2) {
      if (Math.random() < 0.8) {
        pluck(PENTA[(Math.random() * PENTA.length) | 0], Math.max(now, nextPluckAt));
      }
      nextPluckAt = Math.max(now, nextPluckAt) + 2 + Math.random() * 3.5;
    }
  }

  function playChord(notes, at) {
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 620;
    lp.Q.value = 0.4;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.05, at + 2.2);
    g.gain.setValueAtTime(0.05, at + 5.6);
    g.gain.linearRampToValueAtTime(0, at + 8.6);
    lp.connect(g); g.connect(musicGain);
    for (var i = 0; i < notes.length; i++) {
      for (var d = -1; d <= 1; d += 2) {
        var o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midi(notes[i]);
        o.detune.value = d * 5 + (Math.random() - 0.5) * 3;
        o.connect(lp);
        o.start(at);
        o.stop(at + 8.8);
      }
    }
  }

  function pluck(note, at) {
    var o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midi(note);
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1500;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.09, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.7);
    o.connect(lp); lp.connect(g);
    g.connect(musicGain); g.connect(delaySend);
    o.start(at); o.stop(at + 0.8);
  }

  function startCrackle() {
    var len = ctx.sampleRate * 2;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * 0.012;               // hiss floor
      if (Math.random() < 0.0004) d[i] = (Math.random() * 2 - 1) * 0.4; // pops
    }
    var src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600;
    var g = ctx.createGain(); g.gain.value = 0.5;
    src.connect(lp); lp.connect(g); g.connect(musicGain);
    src.start();
  }

  // ---------- SFX ----------

  function applyVolumes() {
    if (!ctx) return;
    musicGain.gain.value = 0.5 * vols.music;
    donkGain.gain.value = vols.donk;
    pingGain.gain.value = vols.ping;
  }
  function setVolumes(v) {
    if (v) {
      if (v.music != null) vols.music = v.music;
      if (v.donk != null) vols.donk = v.donk;
      if (v.ping != null) vols.ping = v.ping;
    }
    applyVolumes();
  }

  function blip(freq, dur, gain, type, at, dest) {
    if (!ctx) return;
    at = at || ctx.currentTime;
    var o = ctx.createOscillator();
    o.type = type || 'sine';
    o.frequency.value = freq;
    var g = ctx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + dur);
    o.connect(g); g.connect(dest || pingGain);
    o.start(at); o.stop(at + dur + 0.05);
    return o;
  }

  // each color donks its own pentatonic note — a landing crowd plays a chord
  var COLOR_STEP = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];

  function plink(r, impact, colorIdx) {
    if (!ctx || muted) return;
    var now = performance.now();
    plinkTimes = plinkTimes.filter(function (t) { return now - t < 120; });
    if (plinkTimes.length >= 3) return;
    plinkTimes.push(now);
    var step = COLOR_STEP[(colorIdx || 0) % COLOR_STEP.length];
    var f = U.clamp(330 * (CONFIG.R0 / r) * Math.pow(2, step / 12), 110, 1500) *
            (0.98 + Math.random() * 0.04);
    var g = U.clamp(0.04 + (impact || 200) / 4500, 0.04, 0.16);
    blip(f, 0.14, g, 'sine', null, donkGain);
    blip(f * 0.5, 0.1, g * 0.5, 'triangle', null, donkGain);
  }

  function pop() {
    if (!ctx || muted) return;
    var at = ctx.currentTime;
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(280, at);
    o.frequency.exponentialRampToValueAtTime(900, at + 0.09);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.14, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.12);
    o.connect(g); g.connect(donkGain);
    o.start(at); o.stop(at + 0.15);
  }

  function buy() {
    if (!ctx || muted) return;
    var at = ctx.currentTime;
    blip(660, 0.07, 0.1, 'square', at);
    blip(880, 0.09, 0.1, 'square', at + 0.07);
  }

  function tada() {
    if (!ctx || muted) return;
    var at = ctx.currentTime;
    blip(523, 0.1, 0.07, 'triangle', at);
    blip(659, 0.1, 0.07, 'triangle', at + 0.08);
    blip(784, 0.22, 0.08, 'triangle', at + 0.16);
  }

  function klaxon() {
    if (!ctx || muted) return;
    var at = ctx.currentTime;
    for (var i = 0; i < 2; i++) {
      var o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(230, at + i * 0.45);
      o.frequency.linearRampToValueAtTime(180, at + i * 0.45 + 0.34);
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 900;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.11, at + i * 0.45);
      g.gain.exponentialRampToValueAtTime(0.001, at + i * 0.45 + 0.4);
      o.connect(lp); lp.connect(g); g.connect(pingGain);
      o.start(at + i * 0.45); o.stop(at + i * 0.45 + 0.45);
    }
  }

  function fanfare() {
    if (!ctx || muted) return;
    var at = ctx.currentTime;
    var arp = [60, 64, 67, 72, 76];
    for (var i = 0; i < arp.length; i++) {
      blip(midi(arp[i]), 0.3, 0.11, 'square', at + i * 0.09);
    }
    // the big chord
    var chord = [48, 60, 64, 67, 72];
    for (var c = 0; c < chord.length; c++) {
      var o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midi(chord[c]);
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1800;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0, at + 0.5);
      g.gain.linearRampToValueAtTime(0.05, at + 0.6);
      g.gain.setValueAtTime(0.05, at + 1.6);
      g.gain.linearRampToValueAtTime(0, at + 2.6);
      o.connect(lp); lp.connect(g); g.connect(pingGain);
      o.start(at + 0.5); o.stop(at + 2.7);
    }
    // swoosh
    var len = ctx.sampleRate * 1.2;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var dd = buf.getChannelData(0);
    for (var j = 0; j < len; j++) dd[j] = (Math.random() * 2 - 1) * (j / len);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(300, at);
    bp.frequency.exponentialRampToValueAtTime(3200, at + 1.1);
    var sg = ctx.createGain(); sg.gain.value = 0.14;
    src.connect(bp); bp.connect(sg); sg.connect(pingGain);
    src.start(at);
  }

  function boom() {
    if (!ctx || muted) return;
    var at = ctx.currentTime;
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, at);
    o.frequency.exponentialRampToValueAtTime(40, at + 0.5);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.3, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.7);
    o.connect(g); g.connect(pingGain);
    o.start(at); o.stop(at + 0.8);
  }

  function unlock() { // call on first user gesture
    if (ensure() && ctx.state === 'suspended') ctx.resume();
  }

  function setMuted(m) {
    muted = m;
    if (master) master.gain.value = m ? 0 : 0.85;
  }

  window.Sound = { unlock: unlock, setMuted: setMuted, setVolumes: setVolumes,
                   plink: plink, pop: pop,
                   buy: buy, tada: tada, klaxon: klaxon, fanfare: fanfare,
                   boom: boom,
                   get muted() { return muted; } };
})();
