// Lightweight, dependency-free visual effects: confetti burst for great
// scores, a comedic "fart" burst + screen shake for rough ones. Pure DOM +
// CSS animations so it works without any external library or network call.

function getFxLayer() {
  let layer = document.getElementById("fxLayer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "fxLayer";
    document.body.appendChild(layer);
  }
  return layer;
}

const CONFETTI_COLORS = ["#ffd166", "#06d6a0", "#118ab2", "#ef476f", "#f78c6b", "#ffffff"];

function launchConfetti(count = 60) {
  const layer = getFxLayer();
  for (let i = 0; i < count; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    piece.style.animationDuration = `${1.4 + Math.random() * 1.2}s`;
    piece.style.animationDelay = `${Math.random() * 0.3}s`;
    piece.style.setProperty("--drift", `${(Math.random() - 0.5) * 200}px`);
    piece.style.setProperty("--spin", `${360 * (Math.random() > 0.5 ? 1 : -1) * (1 + Math.random())}deg`);
    layer.appendChild(piece);
    piece.addEventListener("animationend", () => piece.remove());
  }
}

const FART_EMOJI = ["💨", "🤢", "😬", "💩"];

function launchFartEffect(count = 18) {
  const layer = getFxLayer();
  document.body.classList.add("shake");
  setTimeout(() => document.body.classList.remove("shake"), 500);

  for (let i = 0; i < count; i++) {
    const puff = document.createElement("div");
    puff.className = "fart-puff";
    puff.textContent = FART_EMOJI[Math.floor(Math.random() * FART_EMOJI.length)];
    puff.style.left = `${Math.random() * 100}vw`;
    puff.style.animationDuration = `${1.2 + Math.random() * 0.8}s`;
    puff.style.animationDelay = `${Math.random() * 0.25}s`;
    puff.style.setProperty("--drift", `${(Math.random() - 0.5) * 120}px`);
    layer.appendChild(puff);
    puff.addEventListener("animationend", () => puff.remove());
  }
}

// Streak effects: a shimmering gold sparkle burst for a hot (>=95) streak of
// 2+ rounds, or a slow grey "raindrop" burst for a cold (<=20) streak of 2+
// rounds. `strong` (3+ in a row) means more particles and a bigger visual.
function launchStreakEffect(kind, strong = false) {
  const layer = getFxLayer();
  const count = strong ? 40 : 22;

  for (let i = 0; i < count; i++) {
    const piece = document.createElement("div");
    piece.className = kind === "gold" ? "gold-sparkle" : "sad-drop";
    piece.textContent = kind === "gold" ? "✨" : "💧";
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.animationDuration = kind === "gold"
      ? `${0.9 + Math.random() * 0.8}s`
      : `${1.6 + Math.random() * 1.0}s`;
    piece.style.animationDelay = `${Math.random() * 0.35}s`;
    piece.style.setProperty("--drift", `${(Math.random() - 0.5) * (kind === "gold" ? 160 : 60)}px`);
    if (strong) piece.style.fontSize = "1.4em";
    layer.appendChild(piece);
    piece.addEventListener("animationend", () => piece.remove());
  }
}

// Thresholds shared by round + final score reactions.
const GREAT_SCORE_THRESHOLD = 90;
const ROUGH_SCORE_THRESHOLD = 15;

function playScoreEffect(score) {
  if (score >= GREAT_SCORE_THRESHOLD) {
    launchConfetti();
  } else if (score <= ROUGH_SCORE_THRESHOLD) {
    launchFartEffect();
  }
}

// --- Weekday pin + score reaction emoji ---------------------------------
// One color per weekday, purely cosmetic flair for the daily game "pin".
const WEEKDAY_INFO = {
  0: { short: "SUN", color: "#9b5de5" },
  1: { short: "MON", color: "#ef476f" },
  2: { short: "TUE", color: "#f78c6b" },
  3: { short: "WED", color: "#ffd166" },
  4: { short: "THU", color: "#06d6a0" },
  5: { short: "FRI", color: "#118ab2" },
  6: { short: "SAT", color: "#9b5de5" }
};

// Parsed as UTC midnight so the weekday doesn't shift with local timezone.
function weekdayInfoForDate(dateStr) {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return WEEKDAY_INFO[day];
}

// Ironic, deadpan reactions — deliberately no laughing/crying-laughing emoji.
function scoreEmoji(score) {
  if (score >= 95) return "🐐";
  if (score >= 80) return "😎";
  if (score >= 60) return "🧭";
  if (score >= 40) return "🤷";
  if (score >= 20) return "💀";
  return "🥀";
}

// Same tiers as scoreEmoji, exposed as a CSS-class-friendly name so UI
// elements (e.g. the share button's animated border) can react to how good
// the score actually was.
function scoreTier(score) {
  if (score >= 95) return "legendary";
  if (score >= 80) return "great";
  if (score >= 60) return "good";
  if (score >= 40) return "meh";
  if (score >= 20) return "bad";
  return "terrible";
}

function renderWeekdayPin(el, dateStr) {
  if (!el || !dateStr) return;
  const info = weekdayInfoForDate(dateStr);
  el.textContent = info.short;
  el.style.background = info.color;
}

// Small canvas helper used by the share-result image to draw the weekday pin chip.
function drawRoundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// --- Share-card background variety ---------------------------------------
// A "trophy fading into dirt" progression, painted as wavy bands echoing
// the Medelpad coat of arms (a blue shield with alternating silver/red
// wavy stripes) rather than generic diagonal streaks — gold/silver/bronze
// waves for a great score, duller and duller waves for a bad one.
const SHARE_THEME_GOLD = { name: "aurum", wave: "gold" };
const SHARE_THEME_SILVER = { name: "argentum", wave: "silver" };
const SHARE_THEME_BRONZE = { name: "aes", wave: "bronze" };
const SHARE_THEME_DIRT = { name: "jord", wave: "dirt" };
const SHARE_THEME_MUD = { name: "gyttja", wave: "mud" };
const SHARE_THEME_GRIME = { name: "dy", wave: "grime" };

// Simple deterministic string hash (djb2-ish) -> non-negative int.
function hashSeed(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return Math.abs(h | 0);
}

// Picks the share-card background theme based on the final score's tier.
// Each tier maps to exactly one theme (no per-seed randomness) so the
// gold/silver/bronze/dirt progression is always immediately recognizable.
function themeForScore(score) {
  if (score >= 95) return SHARE_THEME_GOLD;
  if (score >= 80) return SHARE_THEME_SILVER;
  if (score >= 60) return SHARE_THEME_BRONZE;
  if (score >= 40) return SHARE_THEME_DIRT;
  if (score >= 20) return SHARE_THEME_MUD;
  return SHARE_THEME_GRIME;
}

function paintShareBackground(ctx, theme, W, H) {
  if (theme.wave === "mud" || theme.wave === "grime") {
    paintEmbarrassingShareBackground(ctx, theme.wave, W, H);
  } else {
    paintWaveShareBackground(ctx, theme.wave, W, H);
  }
}

// Each tier gets a deep base gradient plus a 3-color band trio. The
// metallic tiers (gold/silver/bronze) get glossy gradient-shaded bands;
// "dirt" (a merely mediocre score) gets a flatter, plainer band look.
// Bad/terrible scores (mud/grime) don't use this at all — see
// paintEmbarrassingShareBackground below, which is deliberately ugly.
const WAVE_PALETTES = {
  gold: { base: ["#0a1830", "#123166"], bands: ["#fff3c4", "#e8b93a", "#8a6a12"], shiny: true, glow: "rgba(255, 224, 130, 0.55)" },
  silver: { base: ["#0c1420", "#1c2c40"], bands: ["#ffffff", "#c3d0dc", "#7c8ba0"], shiny: true, glow: "rgba(210, 226, 240, 0.4)" },
  bronze: { base: ["#170f08", "#3a2210"], bands: ["#ffd9a8", "#c17f42", "#6b3f1c"], shiny: true, glow: "rgba(255, 176, 110, 0.32)" },
  dirt: { base: ["#140f08", "#2c2110"], bands: ["#8a6a38", "#5f4622", "#3c2c16"], shiny: false, glow: null },
};

// Draws a soft sine-wave band (like the crest's wavy dividers) filled with
// either a flat color or a gradient (for the shiny metal tiers).
function drawWaveBand(ctx, W, yBase, amplitude, wavelength, phase, thickness, fillStyle, alpha) {
  ctx.beginPath();
  ctx.moveTo(0, yBase + Math.sin(phase) * amplitude);
  for (let x = 0; x <= W; x += 6) {
    const y = yBase + Math.sin((x / wavelength) * Math.PI * 2 + phase) * amplitude;
    ctx.lineTo(x, y);
  }
  for (let x = W; x >= 0; x -= 6) {
    const y = yBase + thickness + Math.sin((x / wavelength) * Math.PI * 2 + phase) * amplitude;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.globalAlpha = 1;
}

// Paints the whole share-card background: a deep gradient base plus 3
// horizontal wavy bands (deterministic per tier, stable across re-renders),
// then a dark scrim so text stays legible over any tier.
function paintWaveShareBackground(ctx, tier, W, H) {
  const p = WAVE_PALETTES[tier];
  const base = ctx.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0, p.base[0]);
  base.addColorStop(1, p.base[1]);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  const rng = mulberry32(hashSeed(tier + "wave"));
  const bandSpecs = [
    { yFrac: 0.32, amp: 16, thickness: 34, alpha: p.shiny ? 0.85 : 0.6 },
    { yFrac: 0.55, amp: 20, thickness: 30, alpha: p.shiny ? 0.75 : 0.5 },
    { yFrac: 0.78, amp: 14, thickness: 26, alpha: p.shiny ? 0.8 : 0.55 },
  ];

  bandSpecs.forEach((spec, i) => {
    const yBase = H * spec.yFrac + (rng() - 0.5) * 12;
    const wavelength = W / (1.6 + rng() * 0.8);
    const phase = rng() * Math.PI * 2;
    let fillStyle;
    if (p.shiny) {
      const grad = ctx.createLinearGradient(0, yBase - spec.amp, 0, yBase + spec.thickness + spec.amp);
      grad.addColorStop(0, p.bands[(i + 1) % p.bands.length]);
      grad.addColorStop(0.5, p.bands[i % p.bands.length]);
      grad.addColorStop(1, p.bands[(i + 2) % p.bands.length]);
      fillStyle = grad;
    } else {
      fillStyle = p.bands[i % p.bands.length];
    }
    drawWaveBand(ctx, W, yBase, spec.amp, wavelength, phase, spec.thickness, fillStyle, spec.alpha);
  });

  // A soft warm glow behind everything for the "you did great" tiers, drawn
  // with an additive-ish blend so it reads as a genuine shine rather than
  // just a brighter fill. Applied before the scrim so the scrim can settle
  // it back down to a subtle halo instead of overpowering the text.
  if (p.glow) {
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    const glow = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.42, Math.max(W, H) * 0.75);
    glow.addColorStop(0, p.glow);
    glow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  ctx.fillStyle = "rgba(0, 0, 0, 0.38)";
  ctx.fillRect(0, 0, W, H);
}

// Deliberately UGLY backgrounds for a bad ("mud") or terrible ("grime")
// score — no nice waves, no shine. Flat sickly color, harsh jagged "crack"
// lines instead of smooth waves, and a big rotated ink-stamp calling out
// the bad result. Getting a good result should look good; getting a bad
// one should look and feel a little embarrassing, on purpose.
const SHAME_STAMPS = {
  mud: { text: "YIKES", flat: "#4a4636", stampColor: "rgba(220, 60, 40, 0.4)", crackColor: "rgba(0,0,0,0.45)" },
  grime: { text: "OOF", flat: "#3a372c", stampColor: "rgba(200, 20, 20, 0.5)", crackColor: "rgba(0,0,0,0.6)" },
};

function paintEmbarrassingShareBackground(ctx, tier, W, H) {
  const s = SHAME_STAMPS[tier];

  // Flat, deliberately dull/sickly color — no gradient, no shine.
  ctx.fillStyle = s.flat;
  ctx.fillRect(0, 0, W, H);

  // Harsh jagged crack lines (unlike the smooth waves used for a decent
  // score) — visually says "something broke here."
  const rng = mulberry32(hashSeed(tier + "crack"));
  const crackCount = tier === "grime" ? 7 : 5;
  ctx.save();
  ctx.strokeStyle = s.crackColor;
  ctx.lineWidth = 3;
  for (let i = 0; i < crackCount; i++) {
    let x = rng() * W;
    let y = 0;
    ctx.beginPath();
    ctx.moveTo(x, y);
    while (y < H) {
      x += (rng() - 0.5) * 80;
      y += 18 + rng() * 26;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();

  // A big rotated "stamp", like an ink rejection stamp, calling out the bad
  // result directly on the card.
  ctx.save();
  ctx.translate(W * 0.55, H * 0.4);
  ctx.rotate(-0.22);
  ctx.font = "bold 92px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = s.stampColor;
  ctx.fillText(s.text, 0, 0);
  ctx.restore();

  ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
  ctx.fillRect(0, 0, W, H);
}


// Draws text with a subtle gradient fill plus a fine "guilloché" micro-line
// overlay clipped to the glyphs themselves (via source-atop compositing) —
// the same trick passports/ID cards use so the number can't just be painted
// over or retyped in an image editor without it looking obviously flat/off.
// Not meant to be uncrackable, just enough extra effort to deter casual
// score-faking of a shared screenshot.
function drawSecureText(ctx, text, x, y, font, colors, seed) {
  ctx.save();
  ctx.font = font;
  const fontSize = parseInt(font.match(/(\d+)px/)?.[1] || "24", 10);
  const width = ctx.measureText(text).width;

  const grad = ctx.createLinearGradient(x, y - fontSize, x + width, y);
  colors.forEach((c, i) => grad.addColorStop(i / (colors.length - 1 || 1), c));
  ctx.fillStyle = grad;
  ctx.fillText(text, x, y);

  // Very faint diagonal micro-lines, only visible where the glyphs already
  // have ink (source-atop), deterministic per seed so re-renders are
  // stable. Kept subtle on purpose — not meant to be a visible "watermark",
  // just enough texture to notice if someone edited the number and looks
  // closely.
  ctx.save();
  ctx.globalCompositeOperation = "source-atop";
  const rng = mulberry32(seed);
  const pad = fontSize * 0.4;
  const top = y - fontSize - pad, bottom = y + pad;
  const left = x - pad, right = x + width + pad;
  ctx.lineWidth = 0.6;
  const spacing = Math.max(3, fontSize * 0.13);
  for (let lx = left - (bottom - top); lx < right; lx += spacing) {
    const jitter = (rng() - 0.5) * 0.6;
    ctx.strokeStyle = rng() > 0.5 ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)";
    ctx.beginPath();
    ctx.moveTo(lx + jitter, top);
    ctx.lineTo(lx + (bottom - top) + jitter, bottom);
    ctx.stroke();
  }
  ctx.restore();
  ctx.restore();
}

// Tiny deterministic PRNG (mulberry32) so the mud-blotch layout is stable
// per mud-tier rather than re-randomizing (and flickering) on every redraw.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Animates a number counting up from 0 to `target` inside `el`, appending
// `suffix` (e.g. " / 100") once finished. Used so scores feel like they're
// climbing rather than just appearing.
function animateScoreCountUp(el, target, { duration = 700, prefix = "", suffix = "" } = {}) {
  const start = performance.now();
  function tick(now) {
    const elapsed = now - start;
    const t = Math.min(1, elapsed / duration);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    const value = Math.round(target * eased);
    el.textContent = `${prefix}${value}${suffix}`;
    if (t < 1) {
      requestAnimationFrame(tick);
    } else {
      el.textContent = `${prefix}${target}${suffix}`;
    }
  }
  requestAnimationFrame(tick);
}
