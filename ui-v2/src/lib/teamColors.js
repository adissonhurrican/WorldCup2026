const DRAW_COLOR = "#A8A8AE";
const NEUTRAL_AWAY_COLOR = "#475569";
const FALLBACK_HOME_COLOR = "#64748B";
const FALLBACK_AWAY_COLOR = "#475569";
const MIN_DELTA_E = 30;

export function resolvePredictionColors(homeCode, awayCode, colorMap = {}) {
  const map = colorMap && colorMap.teams ? colorMap.teams : colorMap;
  const home = colorEntry(map, homeCode, FALLBACK_HOME_COLOR);
  const away = colorEntry(map, awayCode, FALLBACK_AWAY_COLOR);

  let awayColor = away.primary;
  let awaySource = "primary";

  if (colorsClash(home.primary, awayColor)) {
    if (away.secondary && !colorsClash(home.primary, away.secondary)) {
      awayColor = away.secondary;
      awaySource = "secondary";
    } else {
      awayColor = NEUTRAL_AWAY_COLOR;
      awaySource = "neutral_fallback";
    }
  }

  return {
    home: segmentInfo(home.primary, "primary"),
    draw: segmentInfo(DRAW_COLOR, "neutral_draw"),
    away: segmentInfo(awayColor, awaySource),
    clash_adjusted: awaySource !== "primary",
  };
}

export function segmentCssVars(hex) {
  const color = normalizeHex(hex) || FALLBACK_HOME_COLOR;
  return {
    "--seg-color": color,
    "--seg-top": mixHex(color, "#FFFFFF", 0.24),
    "--seg-bottom": mixHex(color, "#000000", 0.18),
  };
}

export function isLightColor(hex) {
  return relativeLuminance(hex) > 0.82;
}

export function colorsClash(a, b) {
  const colorA = normalizeHex(a);
  const colorB = normalizeHex(b);
  if (!colorA || !colorB) return false;
  const delta = colorDistance(colorA, colorB);
  if (delta < MIN_DELTA_E) return true;

  const hslA = rgbToHsl(...hexToRgb(colorA));
  const hslB = rgbToHsl(...hexToRgb(colorB));
  if (hslA.s < 0.2 || hslB.s < 0.2) return false;
  const hueGap = Math.min(Math.abs(hslA.h - hslB.h), 360 - Math.abs(hslA.h - hslB.h));
  const lumGap = Math.abs(relativeLuminance(colorA) - relativeLuminance(colorB));
  return hueGap < 30 && lumGap < 0.24;
}

export function colorDistance(a, b) {
  const labA = rgbToLab(...hexToRgb(a));
  const labB = rgbToLab(...hexToRgb(b));
  return Math.sqrt(
    Math.pow(labA.l - labB.l, 2) +
    Math.pow(labA.a - labB.a, 2) +
    Math.pow(labA.b - labB.b, 2),
  );
}

function colorEntry(map, code, fallback) {
  const raw = (map && code && map[code]) || {};
  return {
    primary: normalizeHex(raw.primary) || fallback,
    secondary: normalizeHex(raw.secondary),
  };
}

function segmentInfo(color, source) {
  const hex = normalizeHex(color) || FALLBACK_HOME_COLOR;
  return {
    color: hex,
    source,
    light: isLightColor(hex),
  };
}

function normalizeHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  return m ? `#${m[1].toUpperCase()}` : null;
}

function hexToRgb(hex) {
  const h = normalizeHex(hex) || "#000000";
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function mixHex(hex, targetHex, amount) {
  const a = hexToRgb(hex);
  const b = hexToRgb(targetHex);
  return rgbToHex(a.map((v, i) => v + (b[i] - v) * amount));
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function rgbToLab(r, g, b) {
  let [x, y, z] = rgbToXyz(r, g, b);
  x /= 95.047;
  y /= 100.0;
  z /= 108.883;

  x = labPivot(x);
  y = labPivot(y);
  z = labPivot(z);

  return {
    l: 116 * y - 16,
    a: 500 * (x - y),
    b: 200 * (y - z),
  };
}

function rgbToXyz(r, g, b) {
  const srgb = [r, g, b].map((v) => {
    v /= 255;
    return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  });
  const [rr, gg, bb] = srgb.map((v) => v * 100);
  return [
    rr * 0.4124 + gg * 0.3576 + bb * 0.1805,
    rr * 0.2126 + gg * 0.7152 + bb * 0.0722,
    rr * 0.0193 + gg * 0.1192 + bb * 0.9505,
  ];
}

function labPivot(v) {
  return v > 0.008856 ? Math.pow(v, 1 / 3) : 7.787 * v + 16 / 116;
}
