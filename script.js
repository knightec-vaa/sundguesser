// SundGuesser - Sundsvall GeoGuessr-like game
// Daily games are fetched pre-encrypted from data/games/<date>.enc.json and
// decrypted server-side during deploy into data/games/<date>.json.
const ROUND_COUNT = 5;
const DISTANCE_DECAY_METERS = 450; // controls how quickly score falls off with distance (lower = harder)
const DISTANCE_SCORE_EXPONENT = 1.3; // >1 sharpens the mid-range falloff (harder, more precise scoring)
const PERFECT_DISTANCE_METERS = 8; // guesses this close are treated as a perfect 100
const SCORES_STORAGE_KEY = "sundguesser:scores";
const ATTEMPTS_STORAGE_KEY = "sundguesser:attempts";
const ROUND_TIME_SECONDS = 120; // 2 minute time limit per round
const HOT_STREAK_SCORE = 95; // score needed on a round to count towards a "hot" streak
const COLD_STREAK_SCORE = 20; // score at/below which a round counts towards a "cold" streak
const STREAK_MIN_LENGTH = 2; // rounds in a row needed before any streak effect shows
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.4;
const CITY_CENTER = [62.3908, 17.3069];

let map, guessMarker, roundLocations, currentRoundIndex, roundScores, resultLayers;
let roundLocked = false; // true while the result panel is showing, so map
                          // clicks don't move the guess marker during review
let activeGameDate = null;
let manifestCache = null;
let currentShareSeed = null;
let currentShareCanvas = null;
let currentMedals = [];
let currentAttemptNumber = 1;
let roundTimerInterval = null;
let roundTimerRemaining = ROUND_TIME_SECONDS;
let hotStreak = 0;
let coldStreak = 0;

// Per-round speed/efficiency tracking, used for the "medal" badges on the
// share card (fast guesser / never needed to zoom in). Reset per game in
// startGame(), appended to per round in makeGuess().
let roundTimesTaken = [];
let roundZoomUsed = [];
let zoomUsedThisRound = false;

// Photo zoom/pan state (see setupPhotoZoom()). Reset every new round.
let zoomScale = 1;
let panX = 0;
let panY = 0;
let zoomDragging = false;
let zoomDragStartX = 0;
let zoomDragStartY = 0;
let zoomDragOriginX = 0;
let zoomDragOriginY = 0;
let pinchStartDist = null;
let pinchStartScale = 1;

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

function roundAreaLabel(location) {
  if (location.area) return location.area;
  const suffix = String(location.name || "").split(",").pop().trim();
  return suffix
    .replace(/^Glebygd\s+/i, "")
    .replace(/\s+tätortsområde$/i, "")
    .replace(/\s+kommun$/i, "");
}

function roundIsHard(location, index) {
  if (location.difficulty) return location.difficulty === "hard";
  // Legacy game files have no difficulty metadata. Preserve their original
  // behavior exactly: only the final round received the hard treatment.
  return index === roundLocations.length - 1;
}

// Phones show a much smaller slice of the map than desktops at the same zoom
// level, so the regional "helping" frame has to pull back further there to keep
// the same amount of context on screen.
function responsiveZoomOffset() {
  const width = map && map.getSize ? map.getSize().x : window.innerWidth;
  if (width < 420) return 1.5;
  if (width < 620) return 1;
  if (width < 820) return 0.5;
  return 0;
}

function frameMapForRound(location) {
  const distance = haversineDistance(CITY_CENTER[0], CITY_CENTER[1], location.lat, location.lng);
  const offset = responsiveZoomOffset();
  if (distance < 2500) {
    map.setView(CITY_CENTER, 12 - offset);
    return;
  }

  // Keep the target inside a broad regional frame without centering directly
  // on it. Outlying rounds therefore remain guessable without handing away
  // the answer through the map viewport.
  const center = [
    (CITY_CENTER[0] + location.lat) / 2,
    (CITY_CENTER[1] + location.lng) / 2
  ];
  const zoom = distance > 18000 ? 9.5 : distance > 9000 ? 10.5 : 11;
  map.setView(center, Math.max(8, zoom - offset));
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
function saveFirstScoreIfMissing(date, score, scores, medals) {
  const saved = loadSavedScores();
  if (saved[date]) return { record: saved[date], justSaved: false };
  const seed = Math.floor(Math.random() * 1e9);
  const record = { score, roundScores: scores, recordedAt: new Date().toISOString(), seed, medals: medals || [] };
  saved[date] = record;
  localStorage.setItem(SCORES_STORAGE_KEY, JSON.stringify(saved));
  return { record, justSaved: true };
}

// Counts every full completion of a given day's game, even replays that
// don't overwrite the official score — used to stamp non-first attempts on
// the share card (e.g. "2ND TRY") so a replayed/re-rolled score can't be
// passed off as someone's original result.
function loadAttempts() {
  try {
    return JSON.parse(localStorage.getItem(ATTEMPTS_STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function bumpAttempt(date) {
  const all = loadAttempts();
  all[date] = (all[date] || 0) + 1;
  localStorage.setItem(ATTEMPTS_STORAGE_KEY, JSON.stringify(all));
  return all[date];
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
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
  // zoomSnap 0.5 keeps the half-step zoom levels used by frameMapForRound()
  // from being rounded away.
  map = L.map("map", { zoomSnap: 0.5 }).setView([62.392, 17.307], 12);
  // Official OpenStreetMap tile server — no API key required. Subject to the
  // OSM tile usage policy (reasonable request volume, proper attribution).
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19
  }).addTo(map);

  map.on("click", (e) => {
    if (roundLocked) return;
    if (guessMarker) {
      guessMarker.setLatLng(e.latlng);
    } else {
      guessMarker = L.marker(e.latlng, { draggable: true }).addTo(map);
    }
    document.getElementById("guessBtn").disabled = false;
  });
}

// --- Photo zoom/pan (so small signage/text in the street photo can be read
// up close) --------------------------------------------------------------
function touchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function applyZoomTransform() {
  const img = document.getElementById("streetPhoto");
  const pane = document.getElementById("photoPane");
  img.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
  pane.classList.toggle("zoomed", zoomScale > 1.001);
}

function clampPan(pane) {
  const rect = pane.getBoundingClientRect();
  const maxX = (rect.width * (zoomScale - 1)) / 2;
  const maxY = (rect.height * (zoomScale - 1)) / 2;
  panX = Math.max(-maxX, Math.min(maxX, panX));
  panY = Math.max(-maxY, Math.min(maxY, panY));
}

function setZoom(newScale) {
  const pane = document.getElementById("photoPane");
  zoomUsedThisRound = true; // any deliberate zoom action counts as "looking around"
  zoomScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newScale));
  if (zoomScale <= 1.001) {
    zoomScale = 1;
    panX = 0;
    panY = 0;
  }
  clampPan(pane);
  applyZoomTransform();
}

function resetZoom() {
  zoomScale = 1;
  panX = 0;
  panY = 0;
  applyZoomTransform();
}

function setupPhotoZoom() {
  const pane = document.getElementById("photoPane");
  const img = document.getElementById("streetPhoto");

  pane.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      setZoom(zoomScale + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    },
    { passive: false }
  );

  pane.addEventListener("dblclick", () => resetZoom());

  img.addEventListener("mousedown", (e) => {
    if (zoomScale <= 1) return;
    zoomDragging = true;
    zoomDragStartX = e.clientX;
    zoomDragStartY = e.clientY;
    zoomDragOriginX = panX;
    zoomDragOriginY = panY;
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!zoomDragging) return;
    panX = zoomDragOriginX + (e.clientX - zoomDragStartX);
    panY = zoomDragOriginY + (e.clientY - zoomDragStartY);
    clampPan(pane);
    applyZoomTransform();
  });
  window.addEventListener("mouseup", () => {
    zoomDragging = false;
  });

  img.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) {
        pinchStartDist = touchDist(e.touches);
        pinchStartScale = zoomScale;
      } else if (e.touches.length === 1 && zoomScale > 1) {
        zoomDragging = true;
        zoomDragStartX = e.touches[0].clientX;
        zoomDragStartY = e.touches[0].clientY;
        zoomDragOriginX = panX;
        zoomDragOriginY = panY;
      }
    },
    { passive: true }
  );
  img.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length === 2 && pinchStartDist) {
        const dist = touchDist(e.touches);
        setZoom(pinchStartScale * (dist / pinchStartDist));
        e.preventDefault();
      } else if (zoomDragging && e.touches.length === 1) {
        panX = zoomDragOriginX + (e.touches[0].clientX - zoomDragStartX);
        panY = zoomDragOriginY + (e.touches[0].clientY - zoomDragStartY);
        clampPan(pane);
        applyZoomTransform();
        e.preventDefault();
      }
    },
    { passive: false }
  );
  img.addEventListener("touchend", (e) => {
    if (e.touches.length < 2) pinchStartDist = null;
    if (e.touches.length === 0) zoomDragging = false;
  });

  document.getElementById("zoomInBtn").addEventListener("click", () => setZoom(zoomScale + ZOOM_STEP));
  document.getElementById("zoomOutBtn").addEventListener("click", () => setZoom(zoomScale - ZOOM_STEP));
  document.getElementById("zoomResetBtn").addEventListener("click", () => resetZoom());
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
  roundLocked = false;
  zoomUsedThisRound = false;
  if (guessMarker) {
    map.removeLayer(guessMarker);
    guessMarker = null;
  }
  document.getElementById("guessBtn").disabled = true;
  document.getElementById("resultOverlay").classList.add("hidden");

  const loc = roundLocations[currentRoundIndex];
  document.getElementById("streetPhoto").src = loc.img;
  frameMapForRound(loc);
  resetZoom();

  const isHardRound = roundIsHard(loc, currentRoundIndex);
  document.getElementById("photoPane").classList.toggle("hard-round", isHardRound);
  const areaHint = document.getElementById("roundAreaHint");
  areaHint.textContent = `📍 Area: ${roundAreaLabel(loc)}`;
  areaHint.classList.toggle("visible", !isHardRound && Boolean(roundAreaLabel(loc)));

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
  roundLocked = true;

  const loc = roundLocations[currentRoundIndex];
  const actualMarker = L.marker([loc.lat, loc.lng], {
    icon: L.divIcon({ className: "actual-marker", html: "📍", iconSize: [24, 24] })
  }).addTo(map);
  resultLayers = [actualMarker];

  let points, distText;
  if (guessMarker) {
    guessMarker.dragging.disable(); // keep it pinned so it doesn't drift away
    const guessLatLng = guessMarker.getLatLng();          // from the result line while the player is
    const distance = haversineDistance(guessLatLng.lat, guessLatLng.lng, loc.lat, loc.lng); // reviewing the map
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

  // Speed/efficiency tracking for the end-of-game medal badges: how long
  // this round took (time limit minus whatever was left) and whether the
  // photo was ever zoomed/panned into during this round.
  roundTimesTaken.push(ROUND_TIME_SECONDS - Math.max(0, roundTimerRemaining));
  roundZoomUsed.push(zoomUsedThisRound);

  document.getElementById("resultTitle").textContent = loc.name;
  document.getElementById("resultDistance").textContent =
    timedOut && guessMarker ? `⏱ Time's up! Distance: ${distText}` : `Distance: ${distText}`;

  const pointsEl = document.getElementById("resultPoints");
  animateScoreCountUp(pointsEl, points, { suffix: ` / 100 ${scoreEmoji(points)}` });
  playScoreEffect(points);
  applyStreakVisuals();

  const isLastRound = currentRoundIndex === ROUND_COUNT - 1;
  document.getElementById("nextBtn").textContent = isLastRound ? "See Final Score" : "Next Round";

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

// Speed/efficiency "medals" for the share card — only awarded on a decent
// score so a lucky-fast-but-terrible guess doesn't get rewarded. Based on
// average time taken per round and whether the photo was ever zoomed/panned.
function computeMedals(score, times, zoomUsed) {
  if (!times || !times.length || score < 60) return [];
  const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
  const medals = [];
  if (avgTime <= 12) medals.push({ icon: "⚡", label: "Lightning Fast" });
  else if (avgTime <= 25) medals.push({ icon: "🏃", label: "Quick Guesser" });
  if (zoomUsed && zoomUsed.length && zoomUsed.every((z) => !z)) {
    medals.push({ icon: "🧭", label: "True Local" });
  }
  return medals;
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

    currentAttemptNumber = bumpAttempt(activeGameDate);
    const medals = computeMedals(finalScore, roundTimesTaken, roundZoomUsed);
    const { record, justSaved } = saveFirstScoreIfMissing(activeGameDate, finalScore, roundScores, medals);
    currentShareSeed = record.seed;
    currentMedals = record.medals || [];
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
  currentMedals = record.medals || [];
  currentAttemptNumber = 1; // viewing the official recorded result, not a new attempt

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

// Renders the share card into the visible #shareCardPreview container. We
// display an <img> (not the raw canvas) because mobile browsers — Firefox
// for Android in particular — only offer the native long-press "Save/Share
// image" context menu for actual <img> elements; a canvas is invisible to
// that menu even though it looks identical. The canvas itself is kept
// in-memory only, so shareResult() can still read its exact pixels for the
// clipboard/share/download paths.
function updateShareCardPreview() {
  currentShareCanvas = drawShareCanvas();
  const container = document.getElementById("shareCardPreview");
  if (!container) return;
  container.innerHTML = "";
  const img = document.createElement("img");
  img.src = currentShareCanvas.toDataURL("image/png");
  img.alt = "SundGuesser result share card";
  container.appendChild(img);
}

// Swaps the share button's animated border tier to match how good the
// score was (shiny gold down to a grimy near-black ring).
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

  const shareScore = finalScoreValue();
  const theme = themeForScore(shareScore);
  paintShareBackground(ctx, theme, W, H, shareScore);

  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.65)";
  ctx.shadowBlur = 6;
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 30px sans-serif";
  if (headerIconImg.complete && headerIconImg.naturalWidth > 0) {
    const iconSize = 34;
    ctx.drawImage(headerIconImg, 28, 20, iconSize, iconSize * (headerIconImg.naturalHeight / headerIconImg.naturalWidth));
    ctx.fillText("SundGuesser", 28 + iconSize + 10, 50);
  } else {
    ctx.fillText("🧭 SundGuesser", 28, 50);
  }
  ctx.restore();

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

    // A replay/retry stamp — only shown when this isn't the player's first
    // completion of this day's game, so a re-rolled score can't be passed
    // off as an original result. Sits just under the weekday chip.
    if (currentAttemptNumber > 1) {
      const tagText = `${ordinal(currentAttemptNumber).toUpperCase()} TRY`;
      ctx.font = "bold 12px sans-serif";
      const tagW = ctx.measureText(tagText).width + 18;
      const tagX = W - tagW - 24;
      const tagY = chipY + chipH + 8;
      ctx.save();
      ctx.translate(tagX + tagW / 2, tagY + 10);
      ctx.rotate(-0.08);
      drawRoundedRect(ctx, -tagW / 2, -10, tagW, 20, 10);
      ctx.fillStyle = "rgba(239, 71, 111, 0.85)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.fillText(tagText, 0, 4);
      ctx.textAlign = "left";
      ctx.restore();
    }
  }

  // A translucent dark panel behind the big score number keeps it legible
  // no matter how bright/light the theme is (e.g. gold-on-gold, or the
  // silver stripe in the "flagg" theme).
  const finalScore = finalScoreValue();
  drawRoundedRect(ctx, 20, 96, 300, 78, 12);
  ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
  ctx.fill();

  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
  ctx.shadowBlur = 10;
  drawSecureText(
    ctx,
    `${finalScore}/100`,
    28,
    165,
    "bold 72px sans-serif",
    ["#ffb347", "#ffe9b8", "#ffb347"],
    hashSeed(`${activeGameDate}-${finalScore}`)
  );
  ctx.restore();

  ctx.font = "48px sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(scoreEmoji(finalScore), 340, 155);

  ctx.font = "16px sans-serif";
  ctx.fillStyle = "#ffffff";
  roundScores.forEach((s, i) => {
    const x = 28 + i * 112;
    const y = 210;
    ctx.fillStyle = "rgba(0,0,0,0.32)";
    ctx.fillRect(x, y, 96, 70);
    ctx.fillStyle = "#ffffff";
    ctx.font = "13px sans-serif";
    ctx.fillText(`Round ${i + 1}`, x + 10, y + 22);
    drawSecureText(
      ctx,
      `${s}`,
      x + 10,
      y + 52,
      "bold 22px sans-serif",
      ["#e8f0ff", "#ffffff", "#cfe0f5"],
      hashSeed(`${activeGameDate}-round${i}-${s}`)
    );
  });

  ctx.font = "13px sans-serif";
  ctx.fillStyle = "#c9d6e3";
  ctx.fillText("Can you beat this score?", 28, H - 18);
  ctx.textAlign = "right";
  ctx.fillText(shareSiteUrl(), W - 28, H - 18);
  ctx.textAlign = "left";

  // Speed/efficiency medal badges, if earned — small pills sitting between
  // the round breakdown and the footer link.
  if (currentMedals.length) {
    let mx = 28;
    const my = 284;
    ctx.font = "bold 13px sans-serif";
    currentMedals.forEach((medal) => {
      const label = `${medal.icon} ${medal.label}`;
      const textW = ctx.measureText(label).width;
      const pillW = textW + 22;
      drawRoundedRect(ctx, mx, my, pillW, 24, 12);
      ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, mx + 11, my + 17);
      mx += pillW + 10;
    });
  }

  return canvas;
}

// The site URL including the active game's date as a query param, so anyone
// who receives the shared image/link (even days later) lands directly on
// that specific day's game instead of "today" (which may have moved on).
function shareSiteUrl() {
  const base = `${window.location.origin}${window.location.pathname}`.replace(/\/index\.html$/, "/");
  return activeGameDate ? `${base}?date=${activeGameDate}` : base;
}

// Firefox for Android accepts a multi-part ClipboardItem (image + text)
// without throwing, but silently drops the image part and only copies the
// text/plain entry — so shareResult() would report "Image copied!" while
// only the link actually landed on the clipboard. There's no reliable way
// to detect this after the fact (write() resolves normally), so we
// feature-detect ahead of time: ClipboardItem.supports() is the standards
// track way to ask "can you actually write this mime type", and where
// that's unavailable we know from testing that Firefox on Android cannot,
// so we skip straight to the download fallback for that combination.
function clipboardImageWriteSupported() {
  if (!navigator.clipboard || !window.ClipboardItem) return false;
  if (typeof ClipboardItem.supports === "function") {
    try {
      return ClipboardItem.supports("image/png");
    } catch (err) {
      return false;
    }
  }
  const ua = navigator.userAgent || "";
  const isFirefox = /Firefox/i.test(ua);
  const isMobile = /Android|Mobile/i.test(ua);
  return !(isFirefox && isMobile);
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
    const file = new File([blob], `sundguesser-${activeGameDate || "result"}.png`, { type: "image/png" });

    // On Android (and iOS Safari), navigator.share() with a file opens the
    // native share sheet with the actual image attached — this is what most
    // players expect "share" to do. Try it first.
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: "SundGuesser",
          text: shareUrl
        });
        status.textContent = "Shared!";
        return;
      } catch (err) {
        // AbortError means the user just closed the share sheet — not a
        // failure, so don't fall through to clipboard/download noise.
        if (err && err.name === "AbortError") {
          status.textContent = "";
          return;
        }
        // Any other error (e.g. unsupported file type) falls through below.
      }
    }

    if (clipboardImageWriteSupported()) {
      try {
        // Write both the image and the site link as separate clipboard
        // representations. Some apps (Slack) paste both; Discord drops the
        // text when an image is also present — but the link is also baked
        // right into the card image itself (bottom-right corner), so it's
        // still visible either way.
        const item = new ClipboardItem({
          "image/png": blob,
          "text/plain": new Blob([shareUrl], { type: "text/plain" })
        });
        await navigator.clipboard.write([item]);
        status.textContent = "Image copied!";
        return;
      } catch (err) {
        // Falls through to the download fallback below.
      }
    }

    // Fallback: trigger a download so the user can still share the image
    // manually (or long-press the preview above, which works everywhere).
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sundguesser-${activeGameDate || "result"}.png`;
    a.click();
    URL.revokeObjectURL(url);
    status.textContent = "Downloaded the image — or long-press the preview above to save/share it directly.";
  }, "image/png");
}

async function startGame(requestedDate) {
  stopRoundTimer();
  document.getElementById("finalOverlay").classList.add("hidden");
  document.getElementById("resultOverlay").classList.add("hidden");
  document.getElementById("startOverlay").classList.add("hidden");
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
    roundTimesTaken = [];
    roundZoomUsed = [];
    hotStreak = 0;
    coldStreak = 0;
    currentShareSeed = null;
    currentMedals = [];
    updateHud();
    // Don't jump straight into round 1 (which would both spoil the photo
    // and silently start the 2-minute timer) — show a start gate first so
    // the player explicitly opts in to starting the clock.
    showStartGate();
  } catch (err) {
    console.error(err);
    showFatalError(err.message || "Failed to load the game.");
  }
}

// Renders a compact list of past played days (most recent first) so players
// can see their history without it spoiling anything about today's game.
function renderScoreHistory() {
  const container = document.getElementById("scoreHistory");
  if (!container) return;
  const saved = loadSavedScores();
  const dates = Object.keys(saved).sort().reverse().slice(0, 7);
  if (dates.length === 0) {
    container.innerHTML = '<p class="scoreHistoryEmpty">No games played yet — good luck!</p>';
    return;
  }
  const items = dates
    .map((d) => {
      const rec = saved[d];
      return `<li><span class="scoreHistoryDate">${d}</span><span class="scoreHistoryScore">${rec.score}/100 ${scoreEmoji(rec.score)}</span></li>`;
    })
    .join("");
  container.innerHTML = `<p class="scoreHistoryLabel">Your recent scores</p><ul class="scoreHistoryList">${items}</ul>`;
}

// The gate shown before a round starts: either "ready to play" (fresh game,
// timer hasn't started) or, if this day was already completed, an option
// to replay or just re-view the saved score — either way nothing about the
// round starts (photo isn't loaded, timer isn't running) until the player
// explicitly presses a button here.
function showStartGate() {
  const saved = getSavedScore(activeGameDate);
  const latestDate = pickDefaultDate(manifestCache);
  const isHistoricalGame = Boolean(latestDate && activeGameDate !== latestDate);
  const title = document.getElementById("startTitle");
  const subtitle = document.getElementById("startSubtitle");
  const viewBtn = document.getElementById("startViewScoreBtn");
  const playBtn = document.getElementById("startPlayBtn");
  const latestBtn = document.getElementById("startLatestGameBtn");

  if (saved) {
    title.textContent = isHistoricalGame
      ? `Already played the ${activeGameDate} game!`
      : "Already played today's game!";
    subtitle.textContent = `Your recorded score was ${saved.score}/100. You can replay for fun (it won't overwrite your official score), or view your saved result.`;
    playBtn.textContent = "🔁 Play Again";
    viewBtn.classList.remove("hidden");
  } else {
    title.textContent = isHistoricalGame
      ? `Ready to play the ${activeGameDate} game?`
      : "Ready to play?";
    subtitle.textContent = "5 rounds, 2 minutes each — the clock starts the moment you press Start.";
    playBtn.textContent = "▶ Start Game";
    viewBtn.classList.add("hidden");
  }

  if (isHistoricalGame) {
    const todayStr = new Date().toISOString().slice(0, 10);
    latestBtn.textContent = latestDate === todayStr
      ? "📅 Play Today's Game"
      : `📅 Play Latest Game (${latestDate})`;
    latestBtn.classList.remove("hidden");
  } else {
    latestBtn.classList.add("hidden");
  }

  renderScoreHistory();
  document.getElementById("startOverlay").classList.remove("hidden");
}

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  setupPhotoZoom();
  startGame(getDateFromUrl());
  document.getElementById("guessBtn").addEventListener("click", makeGuess);
  document.getElementById("nextBtn").addEventListener("click", nextRound);
  document.getElementById("restartBtn").addEventListener("click", () => startGame(activeGameDate));
  document.getElementById("shareBtn").addEventListener("click", shareResult);
  document.getElementById("dateSelect").addEventListener("change", (e) => startGame(e.target.value));
  document.getElementById("viewScoreBtn").addEventListener("click", () => showSavedScoreOverlay(activeGameDate));
  document.getElementById("closeFinalBtn").addEventListener("click", () => {
    document.getElementById("finalOverlay").classList.add("hidden");
  });
  document.getElementById("startPlayBtn").addEventListener("click", () => {
    document.getElementById("startOverlay").classList.add("hidden");
    loadRound();
  });
  document.getElementById("startViewScoreBtn").addEventListener("click", () => {
    document.getElementById("startOverlay").classList.add("hidden");
    showSavedScoreOverlay(activeGameDate);
  });
  document.getElementById("startLatestGameBtn").addEventListener("click", () => {
    const latestDate = pickDefaultDate(manifestCache);
    if (latestDate) startGame(latestDate);
  });
});
