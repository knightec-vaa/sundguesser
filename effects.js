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
// A small palette of aesthetically-matched gradients, plus a couple of
// score-exclusive special ones (a shiny gold theme for 95+, and the
// vaaraniemi.se rainbow reserved for the 80-94 "great" tier). Recolored to
// echo the Medelpad landskap coat of arms (deep blue, vivid blue, red,
// silver/steel). Regular (non-tiered) themes are still picked
// deterministically from a per-score seed so a given completed score always
// redraws the same way, but different people/days see some variety.
const SHARE_THEMES = [
  { name: "medelpad", stops: ["#003d8f", "#0057b8"] },
  { name: "vagor", stops: ["#001c3d", "#003d8f", "#0057b8"] },
  { name: "flagg", stops: ["#003d8f", "#eeeeee", "#d40000"] }
];

const SHARE_THEME_SILVER = { name: "silverskold", stops: ["#334155", "#7fc4ff"] };
const SHARE_THEME_RED = { name: "rostrod", stops: ["#7a0000", "#d40000"] };
const SHARE_THEME_DARK = { name: "djuphav", stops: ["#00142e", "#00316b"] };
const SHARE_THEME_RAINBOW = { name: "rainbow", rainbow: true };
const SHARE_THEME_GOLD = { name: "aurum", gold: true };

// Simple deterministic string hash (djb2-ish) -> non-negative int.
function hashSeed(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return Math.abs(h | 0);
}

// Picks the share-card background theme based on the final score's tier —
// a shiny gold theme is exclusive to 95+, the rainbow easter-egg is
// exclusive to the 80-94 "great" tier, and lower tiers get progressively
// cooler/duller Medelpad-family colors. Within the broad "good" tier a
// per-seed pick still gives some day-to-day variety.
function themeForScore(score, seed) {
  if (score >= 95) return SHARE_THEME_GOLD;
  if (score >= 80) return SHARE_THEME_RAINBOW;
  if (score >= 60) return SHARE_THEMES[Math.abs(seed) % SHARE_THEMES.length];
  if (score >= 40) return SHARE_THEME_SILVER;
  if (score >= 20) return SHARE_THEME_RED;
  return SHARE_THEME_DARK;
}

// Fills the canvas background with the given theme's gradient, then applies
// a dark scrim so white text stays readable regardless of theme. `theme.
// stops` can be any length (2+) — evenly distributed along the gradient —
// to support both simple 2-color themes and the "flagg"/"vagor" 3-stop
// ones. The gold theme gets a dedicated shiny/diagonal-shine treatment
// instead of a plain gradient.
function paintShareBackground(ctx, theme, W, H) {
  if (theme.gold) {
    paintGoldShareBackground(ctx, W, H);
    return;
  }
  const grad = ctx.createLinearGradient(0, 0, W, H);
  if (theme.rainbow) {
    const hues = [0, 45, 90, 150, 210, 270, 330];
    hues.forEach((h, i) => grad.addColorStop(i / (hues.length - 1), `hsl(${h}, 75%, 45%)`));
  } else {
    theme.stops.forEach((color, i) => grad.addColorStop(i / (theme.stops.length - 1), color));
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // Slightly heavier scrim on the rainbow theme since its hues swing bright
  // enough to fight with white text; other themes are already darker.
  ctx.fillStyle = theme.rainbow ? "rgba(0, 0, 0, 0.42)" : "rgba(0, 0, 0, 0.35)";
  ctx.fillRect(0, 0, W, H);
}

// A dedicated "shiny gold" background reserved for 95+ scores: a warm
// gold/bronze gradient with a few diagonal light-sweep streaks (drawn as
// static translucent bands, evoking a metallic shine on a single frame),
// then a dark scrim so text still reads clearly on top.
function paintGoldShareBackground(ctx, W, H) {
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#3d2c00");
  grad.addColorStop(0.5, "#caa32c");
  grad.addColorStop(1, "#3d2c00");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = "#fffbe6";
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
