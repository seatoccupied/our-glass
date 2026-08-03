/* All-procedural WebAudio: a chill lo-fi bed, plinks, pops, and the flip
   fanfare. No audio files anywhere. Global: Sound

   ---- Bus shape ----
   master --(limiter: DynamicsCompressorNode)--> destination
   musicGain -> duckGain -> padFilter -> master     (the song bed)
   donkGain -> master                               (sandmen impacts — unducked, unfiltered)
   pingGain -> master                                (chimes/stingers — unducked, unfiltered)
   delaySend -> feedback delay -> musicGain           (tape-echo, feeds the bed upstream of duck/filter)
   klaxon()/fanfare() ramp duckGain 1.0->0.35->1.0 (setTargetAtTime) so a stinger
   reads through the bed instead of fighting it. padFilter is ONE shared lowpass
   (not recreated per chord) whose cutoff opens as Pile.fillFraction() rises —
   the score brightens toward the flip.

   ---- Songs ----
   5 songs (SONGS below), each a chord progression + harmonic rhythm + a
   7-note scale for ambient plucks + an optional signature "pulse" (heartbeat
   thump or echoing arp). Song 1 is the original Am7-Fmaj7-Cmaj7-G7 bed.
   Playback runs ~3-minute chunks (songChunkSeconds), crossfading
   (crossfadeSeconds) into the next song from a shuffle bag that never repeats
   immediately, forever (see schedule()/startSong()/stopSong()). Until the
   first-ever flip (Econ.counts.flips === 0) only Song 1 plays — the songbook
   opens when the world first turns over.

   ---- Era layering ----
   Each song also carries 15 texture layers (ERA_PLAN/LAYER_TYPES ->
   buildLayers()), tagged with the era they join: 3 audible at era 1, growing
   to all 15 by era 10. Layers are texture (drone/harmony/counter/bell/soft
   pulse), never intensity jumps — everything but the main pad is a single
   oscillator. flip.js calls Sound.setEra(n) at the era-change moment; because
   the scheduler (tickEntry) re-checks `currentEra` every lookahead tick and
   lazily initializes each layer's first trigger time on demand, a newly
   eligible layer just starts appearing within the next ~400ms-3s — no special
   fade-in bookkeeping needed (drone layers ramp in over 3s on their own).

   ---- Dev-only render harness ----
   Sound._render(spec) renders an OfflineAudioContext excerpt (WAV, base64) of
   any song/era/duck moment — never called during real play. See
   test/audio-render.html + test/audio-render.js. */
(function () {
  'use strict';

  // ---------- bus nodes (module-level; (re)built by buildGraph) ----------
  var ctx = null, master = null, limiter = null;
  var musicGain = null, duckGain = null, padFilter = null;
  var donkGain = null, pingGain = null, delaySend = null;
  var muted = false;
  var vols = { music: 0.75, donk: 0.6, ping: 0.6 };  // pre-boot defaults; main.js
                                                     // applies Save.volumes at init
  var plinkTimes = [];

  // ---- tunables ----
  var LIMITER_THRESHOLD = -18;  // ✏️ TUNE dB
  var LIMITER_RATIO = 4;        // ✏️ TUNE
  var LIMITER_ATTACK = 0.003;   // ✏️ TUNE seconds
  var LIMITER_RELEASE = 0.25;   // ✏️ TUNE seconds
  var PAD_FILTER_MIN_HZ = 480;  // ✏️ TUNE: pad brightness at an empty glass
  var PAD_FILTER_MAX_HZ = 2400; // ✏️ TUNE: pad brightness right before a flip
  var DUCK_DEPTH = 0.35;        // ✏️ TUNE: how far the bed ducks under a stinger
  var DUCK_DOWN_TC = 0.03;      // ✏️ TUNE: duck-down time constant (fast)
  var DUCK_UP_TC = 0.35;        // ✏️ TUNE: duck-recovery time constant (slow)
  var DUCK_HOLD = 0.45;         // ✏️ TUNE: seconds held down before recovery starts
  var songChunkSeconds = 180;   // ✏️ TUNE: ~3 minutes per song before crossfading
  var crossfadeSeconds = 20;    // ✏️ TUNE: song-to-song crossfade length
                                // (8 → 20 s4: Zach wants longer, subtler handoffs)

  function midi(n) { return 440 * Math.pow(2, (n - 69) / 12); }

  // ---------- song data ----------
  // Each song: harmonicRhythm (sec/chord), 4 chords x 5 notes (the fat pad),
  // a 7-note scale (ambient plucks + arp), pluckDensity (relative rate), and
  // an optional signature pulse ({kind:'heartbeat'|'arp', ...}).
  var SONGS = [
    { // Song 1 — "The First Grains": the original bed, warm and moderate
      id: 'grains', harmonicRhythm: 8, pluckDensity: 1,
      chords: [
        [45, 52, 55, 60, 64],  // Am7
        [41, 48, 53, 57, 60],  // Fmaj7
        [36, 48, 52, 55, 59],  // Cmaj7
        [43, 50, 55, 59, 62]   // G7
      ],
      scale: [69, 72, 74, 76, 79, 81, 84],
      pulse: null
    },
    { // Song 2 — "Low Tide": drowsier, lower register, slow harmonic rhythm
      id: 'low-tide', harmonicRhythm: 11, pluckDensity: 0.55,
      chords: [
        [26, 33, 38, 45, 48],
        [27, 34, 39, 46, 50],
        [29, 36, 41, 48, 53],
        [24, 36, 43, 48, 52]
      ],
      scale: [50, 53, 55, 57, 60, 62, 65],
      pulse: null
    },
    { // Song 3 — "Open Sky": brighter, more open voicings, faster rhythm
      id: 'open-sky', harmonicRhythm: 6, pluckDensity: 1.4,
      chords: [
        [60, 64, 67, 71, 74],
        [55, 59, 62, 66, 71],
        [57, 60, 64, 67, 71],
        [53, 57, 60, 64, 69]
      ],
      scale: [72, 74, 76, 79, 81, 84, 86],
      pulse: null
    },
    { // Song 4 — "Slow Heartbeat": very slow chords + a lub-dub sub pulse
      id: 'slow-heartbeat', harmonicRhythm: 14, pluckDensity: 0.4,
      chords: [
        [40, 43, 47, 50, 57],
        [36, 52, 55, 59, 62],
        [43, 47, 50, 52, 55],
        [38, 45, 50, 52, 57]
      ],
      scale: [52, 55, 57, 59, 62, 64, 67],
      pulse: { kind: 'heartbeat', interval: 2.6 }
    },
    { // Song 5 — "Echo Arp": moderate chords + a soft, heavily-echoed arp
      id: 'echo-arp', harmonicRhythm: 9, pluckDensity: 0.8,
      chords: [
        [47, 50, 54, 57, 59],
        [43, 47, 50, 54, 55],
        [50, 54, 57, 61, 64],
        [45, 49, 52, 54, 59]
      ],
      scale: [62, 64, 66, 69, 71, 74, 76],
      pulse: { kind: 'arp', interval: 0.85, steps: [0, 2, 4, 3, 1, 4, 2] }
    }
  ];

  // 15 texture layers per song: 3 at era 1, growing to all 15 by era 10.
  var ERA_PLAN = [1, 1, 1, 2, 3, 3, 4, 5, 5, 6, 7, 7, 8, 9, 10];
  var LAYER_TYPES = ['drone', 'harmony', 'counter', 'bell', 'pulse2'];
  function buildLayers() {
    var out = [];
    for (var i = 0; i < ERA_PLAN.length; i++) {
      out.push({ id: 'L' + i, era: ERA_PLAN[i], type: LAYER_TYPES[i % LAYER_TYPES.length],
                 voice: (i / LAYER_TYPES.length) | 0 });
    }
    return out;
  }
  for (var si = 0; si < SONGS.length; si++) {
    SONGS[si].root = SONGS[si].chords[0][0];
    SONGS[si].layers = buildLayers();
  }

  var currentEra = 1;

  // ---------- graph construction (shared by real playback + offline render) ----------
  function buildGraph(context) {
    ctx = context;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.85;
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER_THRESHOLD;
    limiter.ratio.value = LIMITER_RATIO;
    limiter.attack.value = LIMITER_ATTACK;
    limiter.release.value = LIMITER_RELEASE;
    master.connect(limiter);
    limiter.connect(ctx.destination);

    musicGain = ctx.createGain();
    duckGain = ctx.createGain();
    duckGain.gain.value = 1;
    padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = PAD_FILTER_MIN_HZ;
    padFilter.Q.value = 0.4;
    musicGain.connect(duckGain);
    duckGain.connect(padFilter);
    padFilter.connect(master);

    donkGain = ctx.createGain();   // sandmen hitting things
    donkGain.connect(master);
    pingGain = ctx.createGain();   // upgrade chimes + fanfares
    pingGain.connect(master);

    // a soft echo for plucks/arps — instant lo-fi space (feeds musicGain, so
    // it ducks and filters right along with everything else on the bed)
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
    applyVolumes();
  }

  function ensure() {
    if (ctx) return true;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      buildGraph(new AC());
      currentEra = (window.Econ && Econ.era) || 1;
      setInterval(schedule, 400);
      return true;
    } catch (e) { return false; }
  }

  // ---------- playback state: a shuffle bag of songs, crossfading entries ----------
  var songBag = [];
  var lastSongIdx = -1;
  var active = [];  // {song, gain, t0, chunkEnd, chordIdx, pulseIdx, next{}, layerStarted{}, ending, endAt, crossfadeStarted}

  function pickNextSongIdx() {
    // s4: ONE song ("The First Grains") until the first-ever flip. The chunk
    // scheduler then "crossfades" song 0 into itself — same code path, and the
    // drone/layer bookkeeping restarts cleanly with each fresh entry. The
    // flips counter persists in the save, so a reloaded post-flip world
    // rotates from the start.
    if (!(window.Econ && Econ.counts && Econ.counts.flips > 0)) {
      lastSongIdx = 0;   // a fresh bag after the flip won't open on a repeat
      return 0;
    }
    if (!songBag.length) {
      songBag = [0, 1, 2, 3, 4];
      for (var i = songBag.length - 1; i > 0; i--) {
        var j = (Math.random() * (i + 1)) | 0;
        var tmp = songBag[i]; songBag[i] = songBag[j]; songBag[j] = tmp;
      }
      if (songBag.length > 1 && songBag[0] === lastSongIdx) {
        var swapAt = 1 + ((Math.random() * (songBag.length - 1)) | 0);
        var t2 = songBag[0]; songBag[0] = songBag[swapAt]; songBag[swapAt] = t2;
      }
    }
    var idx = songBag.shift();
    lastSongIdx = idx;
    return idx;
  }

  function makeEntry(song, t0) {
    var g = ctx.createGain();
    g.gain.value = 0;
    g.connect(musicGain);
    return { song: song, gain: g, t0: t0, chunkEnd: t0, chordIdx: 0, pulseIdx: 0,
             next: {}, layerStarted: {}, ending: false, endAt: 0, crossfadeStarted: false };
  }

  function startSong(idx, fadeInSeconds) {
    var song = SONGS[idx];
    var now = ctx.currentTime;
    var e = makeEntry(song, now);
    e.chunkEnd = now + songChunkSeconds;
    if (fadeInSeconds > 0) {
      e.gain.gain.setValueAtTime(0, now);
      e.gain.gain.linearRampToValueAtTime(1, now + fadeInSeconds);
    } else {
      e.gain.gain.setValueAtTime(1, now);
    }
    active.push(e);
    return e;
  }

  function stopSong(e, fadeOutSeconds) {
    var now = ctx.currentTime;
    e.ending = true;
    var cur = e.gain.gain.value;
    e.gain.gain.cancelScheduledValues(now);
    e.gain.gain.setValueAtTime(cur, now);
    e.gain.gain.linearRampToValueAtTime(0, now + fadeOutSeconds);
    e.endAt = now + fadeOutSeconds;
  }

  function cleanupActive(now) {
    for (var i = active.length - 1; i >= 0; i--) {
      var e = active[i];
      if (e.ending && now > e.endAt + 0.5) {
        try { e.gain.disconnect(); } catch (err) {}
        active.splice(i, 1);
      }
    }
  }

  function activePrimary() {
    for (var i = 0; i < active.length; i++) if (!active[i].ending) return active[i];
    return null;
  }

  function layerInterval(layer, song) {
    var v = layer.voice || 0;
    switch (layer.type) {
      case 'harmony': return song.harmonicRhythm;
      case 'counter': return song.harmonicRhythm * 1.8;
      case 'bell':    return 6 + v * 2.4 + Math.random() * 2;
      case 'pulse2':  return 4 + v * 1.2;
      default: return 6;
    }
  }

  function triggerLayerOnce(e, layer, at) {
    switch (layer.type) {
      case 'harmony': triggerHarmonyOnce(e, layer, at); break;
      case 'counter': triggerCounterOnce(e, layer, at); break;
      case 'bell':    triggerBellOnce(e, layer, at); break;
      case 'pulse2':  triggerPulse2Once(e, layer, at); break;
    }
  }

  // The one scheduler, driven either by real wall-clock (schedule() below,
  // every 400ms with a 1.2s lookahead — same cadence the original chord/pluck
  // loop used) or by the offline render harness stepping simulated time in
  // 1.2s chunks. It never reads ctx.currentTime itself — only the now/horizon
  // it's given — so both callers share it exactly.
  function tickEntry(e, now, horizon) {
    var song = e.song;

    if (e.next.chord == null) e.next.chord = e.t0;
    while (e.next.chord < horizon) {
      playChord(song.chords[e.chordIdx % song.chords.length], e.next.chord, e.gain, song.harmonicRhythm);
      e.chordIdx++;
      e.next.chord += song.harmonicRhythm;
    }

    if (e.next.pluck == null) e.next.pluck = e.t0 + 2 + Math.random() * 2;
    if (e.next.pluck < horizon) {
      if (Math.random() < 0.8) {
        pluck(song.scale[(Math.random() * song.scale.length) | 0], Math.max(now, e.next.pluck), e.gain);
      }
      e.next.pluck = Math.max(now, e.next.pluck) + (2 + Math.random() * 3.5) / (song.pluckDensity || 1);
    }

    if (song.pulse) {
      if (e.next.pulse == null) e.next.pulse = e.t0 + 1;
      while (e.next.pulse < horizon) {
        triggerPulseOnce(e, song.pulse, e.next.pulse, e.pulseIdx);
        e.pulseIdx++;
        e.next.pulse += song.pulse.interval;
      }
    }

    for (var i = 0; i < song.layers.length; i++) {
      var layer = song.layers[i];
      if (layer.era > currentEra) continue;
      var key = layer.id;
      if (layer.type === 'drone') {
        if (!e.layerStarted[key]) {
          e.layerStarted[key] = true;
          var start = Math.max(now, e.t0);
          triggerDrone(e, layer, start, Math.max(4, e.chunkEnd - start));
        }
        continue;
      }
      if (e.next[key] == null) e.next[key] = Math.max(now, e.t0) + Math.random() * 3;
      var interval = layerInterval(layer, song);
      while (e.next[key] < horizon) {
        triggerLayerOnce(e, layer, e.next[key]);
        e.next[key] += interval * (0.85 + Math.random() * 0.3);
      }
    }
  }

  function schedule() {
    if (!ctx) return;
    var now = ctx.currentTime;
    if (!active.length) startSong(pickNextSongIdx(), 0);

    var primary = activePrimary();
    if (primary && !primary.crossfadeStarted && now >= primary.chunkEnd - crossfadeSeconds) {
      primary.crossfadeStarted = true;
      startSong(pickNextSongIdx(), crossfadeSeconds);
      stopSong(primary, crossfadeSeconds);
    }

    for (var i = 0; i < active.length; i++) {
      if (!active[i].ending) tickEntry(active[i], now, now + 1.2);
    }
    cleanupActive(now);
    updatePadFilter(now);
  }

  function updatePadFilter(now) {
    if (!padFilter) return;
    var frac = 0;
    if (window.Pile && Pile.fillFraction) {
      try { frac = Pile.fillFraction(); } catch (e) {}
    }
    frac = Math.max(0, Math.min(1, frac));
    var hz = PAD_FILTER_MIN_HZ + (PAD_FILTER_MAX_HZ - PAD_FILTER_MIN_HZ) * frac;
    padFilter.frequency.setTargetAtTime(hz, now, 1.4);
  }

  // ---------- the fat signature pad (multi-osc — this one stays rich) ----------
  function playChord(notes, at, dest, rhythmSec) {
    dest = dest || musicGain;
    rhythmSec = rhythmSec || 8;
    var g = ctx.createGain();
    var attack = rhythmSec * 0.28, hold = rhythmSec * 0.7, endT = rhythmSec + 0.6;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.05, at + attack);
    g.gain.setValueAtTime(0.05, at + hold);
    g.gain.linearRampToValueAtTime(0, at + endT);
    g.connect(dest);
    for (var i = 0; i < notes.length; i++) {
      for (var d = -1; d <= 1; d += 2) {
        var o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midi(notes[i]);
        o.detune.value = d * 5 + (Math.random() - 0.5) * 3;
        o.connect(g);
        o.start(at);
        o.stop(at + endT + 0.2);
      }
    }
  }

  function pluck(note, at, dest) {
    dest = dest || musicGain;
    var o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midi(note);
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1500;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.09, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.7);
    o.connect(lp); lp.connect(g);
    g.connect(dest); g.connect(delaySend);
    o.start(at); o.stop(at + 0.8);
  }

  // ---------- texture layers (single-oscillator voices) ----------
  function triggerDrone(e, layer, at, sustain) {
    var song = e.song;
    var v = layer.voice || 0;
    var note = song.root - (12 + v * 5);
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = midi(note);
    o.detune.value = (Math.random() - 0.5) * 4;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.045, at + 3);
    var stopAt = at + sustain;
    g.gain.setValueAtTime(0.045, Math.max(at + 3, stopAt - 1.5));
    g.gain.linearRampToValueAtTime(0, stopAt);
    o.connect(g); g.connect(e.gain);
    o.start(at); o.stop(stopAt + 0.1);
  }

  function triggerHarmonyOnce(e, layer, at) {
    var song = e.song;
    var chord = song.chords[e.chordIdx > 0 ? (e.chordIdx - 1) % song.chords.length : 0];
    var tone = chord[chord.length - 1] + 12;
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = midi(tone);
    var g = ctx.createGain();
    var dur = song.harmonicRhythm;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.022, at + dur * 0.4);
    g.gain.linearRampToValueAtTime(0, at + dur + 0.4);
    o.connect(g); g.connect(e.gain);
    o.start(at); o.stop(at + dur + 0.5);
  }

  function triggerCounterOnce(e, layer, at) {
    var song = e.song;
    var idx = (Math.random() * song.scale.length) | 0;
    var note = song.scale[idx];
    var o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midi(note);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.04, at + 0.4);
    g.gain.exponentialRampToValueAtTime(0.001, at + 2.6);
    o.connect(g); g.connect(e.gain); g.connect(delaySend);
    o.start(at); o.stop(at + 2.8);
  }

  function triggerBellOnce(e, layer, at) {
    var song = e.song;
    var idx = (Math.random() * song.scale.length) | 0;
    var note = song.scale[idx] + 12;
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = midi(note);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.045, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 1.4);
    o.connect(g); g.connect(e.gain); g.connect(delaySend);
    o.start(at); o.stop(at + 1.5);
  }

  function triggerPulse2Once(e, layer, at) {
    var song = e.song;
    var o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midi(song.root);
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 480;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.026, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.3);
    o.connect(lp); lp.connect(g); g.connect(e.gain);
    o.start(at); o.stop(at + 0.35);
  }

  // ---------- a song's signature pulse: heartbeat thump or echoing arp ----------
  function triggerPulseOnce(e, songPulse, at, idx) {
    if (songPulse.kind === 'heartbeat') {
      thump(e, at, 58, 1);
      thump(e, at + 0.22, 48, 0.55);
    } else if (songPulse.kind === 'arp') {
      var note = e.song.scale[songPulse.steps[idx % songPulse.steps.length]];
      arpNote(e, at, note);
    }
  }
  function thump(e, at, freq, gainMul) {
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, at);
    o.frequency.exponentialRampToValueAtTime(freq * 0.62, at + 0.28);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.09 * gainMul, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.32);
    o.connect(g); g.connect(e.gain);
    o.start(at); o.stop(at + 0.36);
  }
  function arpNote(e, at, note) {
    var o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midi(note);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.055, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.9);
    o.connect(g); g.connect(e.gain); g.connect(delaySend);
    o.start(at); o.stop(at + 1.0);
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

  function plink(r, impact, colorIdx, charIdx) {
    if (!ctx || muted) return;
    var now = performance.now();
    plinkTimes = plinkTimes.filter(function (t) { return now - t < 120; });
    if (plinkTimes.length >= 3) return;
    plinkTimes.push(now);
    var step = COLOR_STEP[(colorIdx || 0) % COLOR_STEP.length];
    var f = U.clamp(330 * (CONFIG.R0 / r) * Math.pow(2, step / 12), 110, 1500) *
            (0.98 + Math.random() * 0.04);
    var g = U.clamp(0.04 + (impact || 200) / 4500, 0.04, 0.16);
    // s4: the Strange Ones land in their own voice (CHARACTERS[].plink)
    var wave = 'sine';
    if (charIdx != null && window.CHARACTERS && CHARACTERS[charIdx]) {
      var fl = CHARACTERS[charIdx].plink;
      if (fl === 'low') f *= 0.5;
      else if (fl === 'deep') f *= 0.33;
      else if (fl === 'high') f *= 2;
      else if (fl === 'airy') { wave = 'triangle'; f *= 1.25; }
      else if (fl === 'clank') { wave = 'square'; g *= 0.55; }
      f = U.clamp(f, 80, 2400);
    }
    blip(f, 0.14, g, wave, null, donkGain);
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

  // duck the music bed under a stinger: a DEDICATED gain node, never an
  // absolute ramp on musicGain (applyVolumes() writes that directly).
  function duck(at) {
    if (!duckGain) return;
    duckGain.gain.cancelScheduledValues(at);
    duckGain.gain.setValueAtTime(duckGain.gain.value, at);
    duckGain.gain.setTargetAtTime(DUCK_DEPTH, at, DUCK_DOWN_TC);
    duckGain.gain.setTargetAtTime(1.0, at + DUCK_HOLD, DUCK_UP_TC);
  }

  function klaxon(at) {
    if (!ctx || muted) return;
    at = at == null ? ctx.currentTime : at;
    duck(at);
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

  function fanfare(at) {
    if (!ctx || muted) return;
    at = at == null ? ctx.currentTime : at;
    duck(at);
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

  function boom(at) {
    if (!ctx || muted) return;
    at = at == null ? ctx.currentTime : at;
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

  function setEra(n) {
    if (n == null) return;
    currentEra = n; // tickEntry re-reads this every tick; no bookkeeping needed
  }

  // ---------- dev-only offline render (never called during real play) ----------
  // Renders an excerpt to WAV (base64) via OfflineAudioContext. See
  // test/audio-render.html (loads config.js+util.js+sound.js only) and
  // test/audio-render.js (drives it headless and writes files).
  // spec: { songIdx, era, durationSec, fillFrac, stingers:[{at,type}] }
  function render(spec) {
    return new Promise(function (resolve, reject) {
      var saved = { ctx: ctx, master: master, limiter: limiter, musicGain: musicGain,
        duckGain: duckGain, padFilter: padFilter, donkGain: donkGain, pingGain: pingGain,
        delaySend: delaySend, active: active, currentEra: currentEra };
      function restore() {
        ctx = saved.ctx; master = saved.master; limiter = saved.limiter;
        musicGain = saved.musicGain; duckGain = saved.duckGain; padFilter = saved.padFilter;
        donkGain = saved.donkGain; pingGain = saved.pingGain; delaySend = saved.delaySend;
        active = saved.active; currentEra = saved.currentEra;
      }
      try {
        var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!OAC) { reject(new Error('no OfflineAudioContext')); return; }
        var dur = spec.durationSec || 20;
        var sr = 44100;
        var oac = new OAC(2, Math.ceil(dur * sr) + 1, sr);

        buildGraph(oac);
        active = [];
        currentEra = spec.era || 3;
        if (spec.fillFrac != null) {
          var hz = PAD_FILTER_MIN_HZ + (PAD_FILTER_MAX_HZ - PAD_FILTER_MIN_HZ) * U.clamp(spec.fillFrac, 0, 1);
          padFilter.frequency.setValueAtTime(hz, 0);
        }
        var song = SONGS[(spec.songIdx || 0) % SONGS.length];
        var e = makeEntry(song, 0);
        e.gain.gain.setValueAtTime(1, 0);
        e.chunkEnd = dur;
        active.push(e);

        var t = 0, step = 1.2;
        while (t < dur) { tickEntry(e, t, Math.min(t + step, dur)); t += step; }

        if (spec.stingers) {
          spec.stingers.forEach(function (s) {
            if (s.type === 'fanfare') fanfare(s.at);
            else if (s.type === 'boom') boom(s.at);
            else klaxon(s.at);
          });
        }

        oac.startRendering().then(function (buf) {
          var b64 = audioBufferToWavBase64(buf);
          restore();
          resolve(b64);
        }).catch(function (err) { restore(); reject(err); });
      } catch (err) { restore(); reject(err); }
    });
  }

  function audioBufferToWavBase64(buffer) {
    var numCh = buffer.numberOfChannels, len = buffer.length, sr = buffer.sampleRate;
    var blockAlign = numCh * 2;
    var dataSize = len * blockAlign;
    var out = new ArrayBuffer(44 + dataSize);
    var view = new DataView(out);
    function writeStr(off, s) { for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
    writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true); view.setUint32(24, sr, true);
    view.setUint32(28, sr * blockAlign, true); view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data'); view.setUint32(40, dataSize, true);
    var chans = [];
    for (var c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
    var off = 44;
    for (var i = 0; i < len; i++) {
      for (var c2 = 0; c2 < numCh; c2++) {
        var s = Math.max(-1, Math.min(1, chans[c2][i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    var bytes = new Uint8Array(out);
    var binary = '';
    var chunk = 0x8000;
    for (var b = 0; b < bytes.length; b += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(b, b + chunk));
    }
    return btoa(binary);
  }

  window.Sound = { unlock: unlock, setMuted: setMuted, setVolumes: setVolumes,
                   plink: plink, pop: pop,
                   buy: buy, tada: tada, klaxon: klaxon, fanfare: fanfare,
                   boom: boom, setEra: setEra,
                   _render: render,
                   get muted() { return muted; } };
})();
