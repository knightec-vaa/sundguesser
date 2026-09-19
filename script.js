// SundGuesser - Sundsvall GeoGuessr-like game
// Daily games are fetched pre-encrypted from data/games/<date>.enc.json and
// decrypted server-side during deploy into data/games/<date>.json.
const ROUND_COUNT = 5;
const DISTANCE_DECAY_METERS = 450; // controls how quickly score falls off with distance (lower = harder)
const DISTANCE_SCORE_EXPONENT = 1.3; // >1 sharpens the mid-range falloff (harder, more precise scoring)
const PERFECT_DISTANCE_METERS = 8; // guesses this close are treated as a perfect 100
const SCORES_STORAGE_KEY = "sundguesser:scores";
const ROUND_TIME_SECONDS = 120; // 2 minute time limit per round
const HOT_STREAK_SCORE = 95; // score needed on a round to count towards a "hot" streak
const COLD_STREAK_SCORE = 20; // score at/below which a round counts towards a "cold" streak
const STREAK_MIN_LENGTH = 2; // rounds in a row needed before any streak effect shows

let map, guessMarker, roundLocations, currentRoundIndex, roundScores, resultLayers;
let activeGameDate = null;
let manifestCache = null;
let currentShareSeed = null;
let currentShareCanvas = null;
let roundTimerInterval = null;
let roundTimerRemaining = ROUND_TIME_SECONDS;
let hotStreak = 0;
let coldStreak = 0;

// Preloaded once so the share canvas (drawn synchronously) can draw the
// Sundsvall coat-of-arms icon immediately without waiting on image load.
const headerIconImg = new Image();
headerIconImg.src = "favicon.svg";

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // meters
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Distance -> 0-100 percentage score. Close guesses round up to 100; far guesses decay to 0.
// The exponent sharpens the falloff so being "somewhat close" isn't as forgiving —
// a couple of km off should genuinely hurt.
function distanceToScore(distanceMeters) {
  if (distanceMeters <= PERFECT_DISTANCE_METERS) return 100;
  const raw = 100 * Math.exp(-Math.pow(distanceMeters / DISTANCE_DECAY_METERS, DISTANCE_SCORE_EXPONENT));
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- Persisted scores (first completion per day only) -----------------

function loadSavedScores() {
  try {
    return JSON.parse(localStorage.getItem(SCORES_STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function getSavedScore(date) {
  return loadSavedScores()[date] || null;
}

// Only the FIRST time a given day's game is completed is the score kept —
// replays don't overwrite your official result for that day. A random seed
// is stored alongside it so the share-card background stays consistent
// whenever this score is viewed again later.
function saveFirstScoreIfMissing(date, score, scores) {
  const saved = loadSavedScores();
  if (saved[date]) return { record: saved[date], justSaved: false };
  const seed = Math.floor(Math.random() * 1e9);
  const record = { score, roundScores: scores, recordedAt: new Date().toISOString(), seed };
  saved[date] = record;
  localStorage.setItem(SCORES_STORAGE_KEY, JSON.stringify(saved));
  return { record, justSaved: true };
}

// --- URL <-> selected date -----------------------------------------

function getDateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("date");
}

function setDateInUrl(date) {
  const url = new URL(window.location.href);
  url.searchParams.set("date", date);
  window.history.replaceState({}, "", url);
}

function initMap() {
  map = L.map("map").setView([62.392, 17.307], 12);
  // Official OpenStreetMap tile server — no API key required. Subject to the
  // OSM tile usage policy (reasonable request volume, proper attribution).
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19
  }).addTo(map);

  map.on("click", (e) => {
    if (guessMarker) {
      guessMarker.setLatLng(e.latlng);
    } else {
      guessMarker = L.marker(e.latlng, { draggable: true }).addTo(map);
    }
    document.getElementById("guessBtn").disabled = false;
  });
}

function showFatalError(message) {
  const pane = document.getElementById("photoPane");
  pane.innerHTML = `<div class="fatalError">${message}</div>`;
  document.getElementById("guessBtn").disabled = true;
}

async function fetchManifest() {
  if (manifestCache) return manifestCache;
  const res = await fetch("data/manifest.json", { cache: "no-store" });
  if (!res.ok) throw new Error("No games published yet.");
  manifestCache = await res.json();
  return manifestCache;
}

function pickDefaultDate(manifest) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const available = (manifest.dates || []).filter((d) => d <= todayStr).sort();
  if (available.length === 0) return null;
  return available[available.length - 1];
}

async function loadGameForDate(date) {
  const gameRes = await fetch(`data/games/${date}.json`, { cache: "no-store" });
  if (!gameRes.ok) throw new Error(`Failed to load game for ${date}.`);
  const game = await gameRes.json();
  return { date, locations: game.locations };
}

function populateDatePicker(manifest, selectedDate) {
  const select = document.getElementById("dateSelect");
  select.innerHTML = "";
  const todayStr = new Date().toISOString().slice(0, 10);
  const dates = (manifest.dates || []).filter((d) => d <= todayStr).sort().reverse();

  dates.forEach((date) => {
    const opt = document.createElement("option");
    opt.value = date;
    const saved = getSavedScore(date);
    const label = date === todayStr ? `${date} (today)` : date;
    opt.textContent = saved ? `${label} — played (${saved.score}/100)` : label;
    select.appendChild(opt);
  });

  select.value = selectedDate;
}

function updateHud() {
  document.getElementById("roundInfo").textContent = `Round ${currentRoundIndex + 1} / ${ROUND_COUNT}`;
  const avg =
    roundScores.length > 0 ? Math.round(roundScores.reduce((a, b) => a + b, 0) / roundScores.length) : 0;
  const emoji = roundScores.length > 0 ? ` ${scoreEmoji(avg)}` : "";
  document.getElementById("scoreInfo").textContent = `Score: ${avg}/100${emoji}`;
  renderWeekdayPin(document.getElementById("weekdayPin"), activeGameDate);
  updateViewScoreButton();
}

// Shows/hides the "View My Score" button depending on whether the currently
// selected day already has a saved (first) score, so a closed overlay can
// always be reopened.
function updateViewScoreButton() {
  const btn = document.getElementById("viewScoreBtn");
  if (!btn) return;
  const saved = activeGameDate ? getSavedScore(activeGameDate) : null;
  btn.classList.toggle("hidden", !saved);
}

function clearResultLayers() {
  if (resultLayers) {
    resultLayers.forEach((l) => map.removeLayer(l));
  }
  resultLayers = [];
}

function loadRound() {
  clearResultLayers();
  if (guessMarker) {
    map.removeLayer(guessMarker);
    guessMarker = null;
  }
  document.getElementById("guessBtn").disabled = true;
  document.getElementById("resultOverlay").classList.add("hidden");

  const loc = roundLocations[currentRoundIndex];
  document.getElementById("streetPhoto").src = loc.img;
  map.setView([62.392, 17.307], 12);

  const isHardRound = currentRoundIndex === ROUND_COUNT - 1;
  document.getElementById("photoPane").classList.toggle("hard-round", isHardRound);

  updateHud();
  startRoundTimer();
}

function formatTimer(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function startRoundTimer() {
  stopRoundTimer();
  roundTimerRemaining = ROUND_TIME_SECONDS;
  updateTimerDisplay();
  roundTimerInterval = setInterval(() => {
    roundTimerRemaining--;
    updateTimerDisplay();
    if (roundTimerRemaining <= 0) {
      stopRoundTimer();
      makeGuess({ timedOut: true });
    }
  }, 1000);
}

function stopRoundTimer() {
  if (roundTimerInterval) {
    clearInterval(roundTimerInterval);
    roundTimerInterval = null;
  }
}

function updateTimerDisplay() {
  const el = document.getElementById("timerInfo");
  if (!el) return;
  el.textContent = `⏱ ${formatTimer(Math.max(0, roundTimerRemaining))}`;
  el.classList.toggle("timer-low", roundTimerRemaining <= 20);
}

function makeGuess(opts = {}) {
  const timedOut = opts.timedOut === true;
  if (!guessMarker && !timedOut) return;
  stopRoundTimer();

  const loc = roundLocations[currentRoundIndex];
  const actualMarker = L.marker([loc.lat, loc.lng], {
    icon: L.divIcon({ className: "actual-marker", html: "📍", iconSize: [24, 24] })
  }).addTo(map);
  resultLayers = [actualMarker];

  let points, distText;
  if (guessMarker) {
    const guessLatLng = guessMarker.getLatLng();
    const distance = haversineDistance(guessLatLng.lat, guessLatLng.lng, loc.lat, loc.lng);
    points = distanceToScore(distance);
    const line = L.polyline([guessLatLng, [loc.lat, loc.lng]], { color: "red", dashArray: "5,5" }).addTo(map);
    resultLayers.push(line);
    map.fitBounds(line.getBounds(), { padding: [60, 60] });
    distText = distance >= 1000 ? `${(distance / 1000).toFixed(2)} km` : `${Math.round(distance)} m`;
  } else {
    // Timed out with no guess placed at all.
    points = 0;
    distText = "No guess made — time ran out!";
    map.setView([loc.lat, loc.lng], 13);
  }
  roundScores.push(points);
  updateStreaks(points);

  document.getElementById("resultTitle").textContent = loc.name;
  document.getElementById("resultDistance").textContent =
    timedOut && guessMarker ? `⏱ Time's up! Distance: ${distText}` : `Distance: ${distText}`;

  const pointsEl = document.getElementById("resultPoints");
  animateScoreCountUp(pointsEl, points, { suffix: ` / 100 ${scoreEmoji(points)}` });
  playScoreEffect(points);
  applyStreakVisuals();

  document.getElementById("guessBtn").disabled = true;
  document.getElementById("resultOverlay").classList.remove("hidden");
  updateHud();
}

// Tracks consecutive hot (>=95) or cold (<=20) rounds *within the current
// game*. Breaking a streak (a round that's neither) resets both counters.
function updateStreaks(points) {
  if (points >= HOT_STREAK_SCORE) {
    hotStreak++;
    coldStreak = 0;
  } else if (points <= COLD_STREAK_SCORE) {
    coldStreak++;
    hotStreak = 0;
  } else {
    hotStreak = 0;
    coldStreak = 0;
  }
}

// Shows a gold shimmering border (getting shinier at 3+) for a hot streak,
// or a gloomy "sad" border (getting heavier at 3+) for a cold streak, on the
// per-round result popup. Also spawns a matching particle burst.
function applyStreakVisuals() {
  const box = document.getElementById("resultBox");
  const badge = document.getElementById("streakBadge");
  box.classList.remove("streak-gold", "streak-gold-strong", "streak-sad", "streak-sad-strong");
  badge.classList.add("hidden");

  if (hotStreak >= STREAK_MIN_LENGTH) {
    const strong = hotStreak >= 3;
    box.classList.add(strong ? "streak-gold-strong" : "streak-gold");
    badge.textContent = `✨ Hot streak x${hotStreak}!`;
    badge.classList.remove("hidden");
    launchStreakEffect("gold", strong);
  } else if (coldStreak >= STREAK_MIN_LENGTH) {
    const strong = coldStreak >= 3;
    box.classList.add(strong ? "streak-sad-strong" : "streak-sad");
    badge.textContent = `😢 Cold streak x${coldStreak}...`;
    badge.classList.remove("hidden");
    launchStreakEffect("sad", strong);
  }
}

function finalScoreValue() {
  return Math.round(roundScores.reduce((a, b) => a + b, 0) / roundScores.length);
}

function nextRound() {
  currentRoundIndex++;
  if (currentRoundIndex >= ROUND_COUNT) {
    document.getElementById("resultOverlay").classList.add("hidden");
    const finalScore = finalScoreValue();

    const finalScoreEl = document.getElementById("finalScore");
    animateScoreCountUp(finalScoreEl, finalScore, {
      prefix: "Final Score: ",
      suffix: ` / 100 ${scoreEmoji(finalScore)}`
    });
    playScoreEffect(finalScore);

    renderRoundBreakdown();

    const { record, justSaved } = saveFirstScoreIfMissing(activeGameDate, finalScore, roundScores);
    currentShareSeed = record.seed;
    updateShareCardPreview();
    updateShareBtnTier(finalScore);
    document.getElementById("finalOverlay").classList.remove("hidden");

    const noteEl = document.getElementById("firstScoreNote");
    noteEl.textContent = justSaved
      ? "Saved as your official score for this day!"
      : `Your official score for this day was already recorded: ${record.score}/100.`;

    populateDatePicker(manifestCache, activeGameDate);
    updateViewScoreButton();
  } else {
    loadRound();
  }
}

function renderRoundBreakdown() {
  const list = document.getElementById("roundBreakdown");
  list.innerHTML = "";
  roundScores.forEach((s, i) => {
    const li = document.createElement("li");
    li.textContent = `Round ${i + 1}: ${s} / 100`;
    list.appendChild(li);
  });
}

// Re-displays a previously saved (first) score for the given day, e.g. after
// accidentally closing the final overlay. Does not re-save or affect the
// in-progress round state.
function showSavedScoreOverlay(date) {
  const record = getSavedScore(date);
  if (!record) return;

  roundScores = record.roundScores;
  currentShareSeed = typeof record.seed === "number" ? record.seed : hashSeed(`${date}:${record.score}`);

  document.getElementById("finalScore").textContent =
    `Final Score: ${record.score} / 100 ${scoreEmoji(record.score)}`;
  renderRoundBreakdown();
  updateShareCardPreview();
  updateShareBtnTier(record.score);
  document.getElementById("firstScoreNote").textContent =
    `Your official score for this day: ${record.score}/100.`;
  document.getElementById("shareStatus").textContent = "";
  document.getElementById("finalOverlay").classList.remove("hidden");
}

// Renders the share card into the visible #shareCardPreview container (so
// players see exactly what gets copied) and keeps a reference to that same
// canvas so shareResult() copies the identical image instead of redrawing.
function updateShareCardPreview() {
  currentShareCanvas = drawShareCanvas();
  const container = document.getElementById("shareCardPreview");
  if (!container) return;
  container.innerHTML = "";
  container.appendChild(currentShareCanvas);
}

// Swaps the share button's animated border tier to match how good the
// score was (legendary rainbow down to a barely-moving grayscale ring).
function updateShareBtnTier(score) {
  const btn = document.getElementById("shareBtn");
  if (!btn) return;
  btn.classList.remove("tier-legendary", "tier-great", "tier-good", "tier-meh", "tier-bad", "tier-terrible");
  btn.classList.add(`tier-${scoreTier(score)}`);
}

function drawShareCanvas() {
  const canvas = document.createElement("canvas");
  const W = 600, H = 340;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  const seed = typeof currentShareSeed === "number" ? currentShareSeed : hashSeed(activeGameDate || "sundguesser");
  const theme = themeForSeed(seed);
  paintShareBackground(ctx, theme, W, H);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 30px sans-serif";
  if (headerIconImg.complete && headerIconImg.naturalWidth > 0) {
    const iconSize = 34;
    ctx.drawImage(headerIconImg, 28, 20, iconSize, iconSize * (headerIconImg.naturalHeight / headerIconImg.naturalWidth));
    ctx.fillText("SundGuesser", 28 + iconSize + 10, 50);
  } else {
    ctx.fillText("🧭 SundGuesser", 28, 50);
  }

  ctx.font = "16px sans-serif";
  ctx.fillStyle = "#c9d6e3";
  ctx.fillText(activeGameDate ? `Game of ${activeGameDate}` : "", 28, 78);

  // Weekday pin chip, top-right.
  if (activeGameDate) {
    const info = weekdayInfoForDate(activeGameDate);
    const chipW = 64, chipH = 28, chipX = W - chipW - 24, chipY = 24;
    ctx.fillStyle = info.color;
    drawRoundedRect(ctx, chipX, chipY, chipW, chipH, 14);
    ctx.fill();
    ctx.fillStyle = "#101820";
    ctx.font = "bold 14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(info.short, chipX + chipW / 2, chipY + chipH / 2 + 5);
    ctx.textAlign = "left";
  }

  ctx.font = "bold 72px sans-serif";
  ctx.fillStyle = "#ffd166";
  const finalScore = finalScoreValue();
  ctx.fillText(`${finalScore}/100`, 28, 165);

  ctx.font = "48px sans-serif";
  ctx.fillText(scoreEmoji(finalScore), 340, 155);

  ctx.font = "16px sans-serif";
  ctx.fillStyle = "#ffffff";
  roundScores.forEach((s, i) => {
    const x = 28 + i * 112;
    const y = 210;
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(x, y, 96, 70);
    ctx.fillStyle = "#ffffff";
    ctx.font = "13px sans-serif";
    ctx.fillText(`Round ${i + 1}`, x + 10, y + 22);
    ctx.font = "bold 22px sans-serif";
    ctx.fillText(`${s}`, x + 10, y + 52);
  });

  ctx.font = "13px sans-serif";
  ctx.fillStyle = "#8fa5bd";
  ctx.fillText("Can you beat this score?", 28, H - 18);
  ctx.textAlign = "right";
  ctx.fillText(shareSiteUrl(), W - 28, H - 18);
  ctx.textAlign = "left";

  return canvas;
}

// The plain site URL (no query string) so anyone seeing the shared image
// knows where to go play, even if only the image itself gets pasted.
function shareSiteUrl() {
  return `${window.location.origin}${window.location.pathname}`.replace(/\/index\.html$/, "/");
}

async function shareResult() {
  // Reuse the exact canvas already shown in the preview so what gets copied
  // matches what the player sees; fall back to a fresh render if somehow
  // the preview hasn't been drawn yet.
  const canvas = currentShareCanvas || drawShareCanvas();
  const status = document.getElementById("shareStatus");
  const shareUrl = shareSiteUrl();
  canvas.toBlob(async (blob) => {
    if (!blob) return;
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        // Write both the image and the site link as separate clipboard
        // representations. Apps that accept rich paste (Slack/Discord) will
        // paste the image; ones that only accept text fall back to the link.
        const item = new ClipboardItem({
          "image/png": blob,
          "text/plain": new Blob([shareUrl], { type: "text/plain" })
        });
        await navigator.clipboard.write([item]);
        status.textContent = "Image copied! The site link is included too.";
        return;
      }
      throw new Error("Clipboard image API not supported");
    } catch (err) {
      // Fallback: trigger a download so the user can still share the image manually.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sundguesser-${activeGameDate || "result"}.png`;
      a.click();
      URL.revokeObjectURL(url);
      status.textContent = "Clipboard copy isn't supported here — downloaded the image instead.";
    }
  }, "image/png");
}

async function startGame(requestedDate) {
  document.getElementById("finalOverlay").classList.add("hidden");
  document.getElementById("shareStatus").textContent = "";
  const noteEl = document.getElementById("firstScoreNote");
  if (noteEl) noteEl.textContent = "";

  try {
    const manifest = await fetchManifest();
    const todayStr = new Date().toISOString().slice(0, 10);
    const validDates = new Set((manifest.dates || []).filter((d) => d <= todayStr));

    let date = requestedDate && validDates.has(requestedDate) ? requestedDate : pickDefaultDate(manifest);
    if (!date) throw new Error("No games available yet. Check back on a weekday!");

    populateDatePicker(manifest, date);
    setDateInUrl(date);

    const { locations } = await loadGameForDate(date);
    activeGameDate = date;
    // Order matters: generate_game.py deliberately orders rounds
    // easy -> medium -> ... -> hard, so no client-side shuffle here.
    roundLocations = locations;
    currentRoundIndex = 0;
    roundScores = [];
    hotStreak = 0;
    coldStreak = 0;
    currentShareSeed = null;
    updateHud();
    loadRound();
  } catch (err) {
    console.error(err);
    showFatalError(err.message || "Failed to load the game.");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  startGame(getDateFromUrl());
  document.getElementById("guessBtn").addEventListener("click", makeGuess);
  document.getElementById("nextBtn").addEventListener("click", nextRound);
  document.getElementById("restartBtn").addEventListener("click", () => startGame(activeGameDate));
  document.getElementById("shareBtn").addEventListener("click", shareResult);
  document.getElementById("dateSelect").addEventListener("change", (e) => startGame(e.target.value));
  document.getElementById("viewScoreBtn").addEventListener("click", () => showSavedScoreOverlay(activeGameDate));
});
