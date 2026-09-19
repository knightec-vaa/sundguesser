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
// A small palette of aesthetically-matched gradients plus one "rainbow" one
// (a nod to vaaraniemi.se's old rainbow banner). Picked deterministically
// from a per-score seed so a given completed score always redraws the same
// way, but different people/days end up with visible variety.
const SHARE_THEMES = [
  { name: "ocean", stops: ["#1e3a5f", "#274472"] },
  { name: "sunset", stops: ["#c9482f", "#c77a1f"] },
  { name: "forest", stops: ["#134e5e", "#71b280"] },
  { name: "grape", stops: ["#654ea3", "#eaafc8"] },
  { name: "midnight", stops: ["#0f2027", "#2c5364"] },
  { name: "candy", stops: ["#ee0979", "#ff6a00"] },
  { name: "rainbow", rainbow: true }
];

// Simple deterministic string hash (djb2-ish) -> non-negative int.
function hashSeed(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return Math.abs(h | 0);
}

function themeForSeed(seed) {
  const idx = Math.abs(seed) % SHARE_THEMES.length;
  return SHARE_THEMES[idx];
}

// Fills the canvas background with the given theme's gradient, then applies
// a subtle dark scrim so white text stays readable on lighter themes too.
function paintShareBackground(ctx, theme, W, H) {
  const grad = ctx.createLinearGradient(0, 0, W, H);
  if (theme.rainbow) {
    const hues = [0, 45, 90, 150, 210, 270, 330];
    hues.forEach((h, i) => grad.addColorStop(i / (hues.length - 1), `hsl(${h}, 75%, 45%)`));
  } else {
    grad.addColorStop(0, theme.stops[0]);
    grad.addColorStop(1, theme.stops[1]);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
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
