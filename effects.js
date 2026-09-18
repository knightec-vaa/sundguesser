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
