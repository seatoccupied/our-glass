/* Small math / formatting helpers. Global: U */
(function (root) {
  'use strict';
  var TAU = Math.PI * 2;

  // Seeded RNG (mulberry32) — used wherever determinism helps (pile resynthesis).
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
  function easeOutBack(t) {
    var c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  // 12,345 -> "12.3k" etc. Whole numbers below 10k shown plain.
  var SUFFIX = ['', 'k', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
  function fmt(n) {
    if (!isFinite(n)) return '∞';
    n = Math.floor(n);
    if (n < 10000) return String(n);
    var tier = Math.floor(Math.log10(n) / 3);
    if (tier >= SUFFIX.length) tier = SUFFIX.length - 1;
    var v = n / Math.pow(10, tier * 3);
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + SUFFIX[tier];
  }

  function fmtTime(sec) {
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  // '#ff6b6b' shaded by f (-1..1): negative darkens, positive lightens.
  var shadeCache = {};
  function shade(hex, f) {
    var key = hex + '|' + f;
    if (shadeCache[key]) return shadeCache[key];
    var r = parseInt(hex.slice(1, 3), 16),
        g = parseInt(hex.slice(3, 5), 16),
        b = parseInt(hex.slice(5, 7), 16);
    if (f < 0) { r *= 1 + f; g *= 1 + f; b *= 1 + f; }
    else { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
    var out = 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
    shadeCache[key] = out;
    return out;
  }

  root.U = { TAU: TAU, rng: rng, clamp: clamp, lerp: lerp, fmt: fmt, fmtTime: fmtTime,
             easeOutCubic: easeOutCubic, easeInOutCubic: easeInOutCubic,
             easeOutBack: easeOutBack, shade: shade };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.U;
})(typeof window !== 'undefined' ? window : globalThis);
