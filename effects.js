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
// A "trophy fading into dirt" progression: shiny gold for a near-perfect
// score, silver just below it, bronze/copper for a solid middle score, then
// progressively duller/muddier browns for meh/bad/terrible scores. No more
// rainbow — every tier is a distinct, exclusive metallic-or-dirt look tied
// directly to how well you actually did.
const SHARE_THEME_GOLD = { name: "aurum", metal: "gold" };
const SHARE_THEME_SILVER = { name: "argentum", metal: "silver" };
const SHARE_THEME_BRONZE = { name: "aes", metal: "bronze" };
const SHARE_THEME_DIRT = { name: "jord", mud: "light" };
const SHARE_THEME_MUD = { name: "gyttja", mud: "dark" };
const SHARE_THEME_GRIME = { name: "dy", mud: "grime" };

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

// Fills the canvas background with the given theme, then applies a dark
// scrim so white text stays readable regardless of theme. Metallic themes
// (gold/silver/bronze) get a shiny gradient + diagonal light-sweep streaks;
// mud themes get a flatter, grubbier gradient with a subtle blotchy texture.
function paintShareBackground(ctx, theme, W, H) {
  if (theme.metal) {
    paintMetalShareBackground(ctx, theme.metal, W, H);
  } else {
    paintMudShareBackground(ctx, theme.mud, W, H);
  }
}

const METAL_COLORS = {
  gold: { dark: "#3d2c00", mid: "#caa32c", shine: "#fffbe6" },
  silver: { dark: "#2c333d", mid: "#b7c2cc", shine: "#ffffff" },
  bronze: { dark: "#3a2210", mid: "#a9683a", shine: "#ffd9a8" },
};

// Shared shiny-metal painter: gradient + diagonal translucent streaks, used
// for gold (legendary), silver (great) and bronze (good) tiers alike — only
// the color trio changes, so all three read as "the same kind of shiny"
// rather than unrelated one-off effects.
function paintMetalShareBackground(ctx, metal, W, H) {
  const c = METAL_COLORS[metal];
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, c.dark);
  grad.addColorStop(0.5, c.mid);
  grad.addColorStop(1, c.dark);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = c.shine;
  const streakWidth = 26;
  for (let x = -H; x < W + H; x += 70) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + streakWidth, 0);
    ctx.lineTo(x + streakWidth - H, H);
    ctx.lineTo(x - H, H);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
  ctx.fillRect(0, 0, W, H);
}

const MUD_COLORS = {
  light: { top: "#4a3822", bottom: "#2e2211" },
  dark: { top: "#2e2313", bottom: "#1a140a" },
  grime: { top: "#1c1a14", bottom: "#0d0c08" },
};

// Shared muddy painter for the meh/bad/terrible tiers — a flat, desaturated
// brown gradient (progressively darker/duller per tier) with a few soft
// blotches to suggest dried mud/dirt rather than a clean gradient, echoing
// the "brown dirt" look requested for below-average scores.
function paintMudShareBackground(ctx, mud, W, H) {
  const c = MUD_COLORS[mud];
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, c.top);
  grad.addColorStop(1, c.bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = "#000000";
  const rng = mulberry32(hashSeed(mud + W));
  for (let i = 0; i < 10; i++) {
    const bx = rng() * W;
    const by = rng() * H;
    const br = 40 + rng() * 90;
    ctx.beginPath();
    ctx.ellipse(bx, by, br, br * 0.7, rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
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

  // Fine diagonal micro-lines, only visible where the glyphs already have
  // ink (source-atop), deterministic per seed so re-renders are stable.
  ctx.save();
  ctx.globalCompositeOperation = "source-atop";
  const rng = mulberry32(seed);
  const pad = fontSize * 0.4;
  const top = y - fontSize - pad, bottom = y + pad;
  const left = x - pad, right = x + width + pad;
  ctx.lineWidth = 1;
  const spacing = Math.max(2, fontSize * 0.08);
  for (let lx = left - (bottom - top); lx < right; lx += spacing) {
    const jitter = (rng() - 0.5) * 0.6;
    ctx.strokeStyle = rng() > 0.5 ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.35)";
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
