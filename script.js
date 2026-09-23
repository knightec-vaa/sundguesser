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
const DAILY_STREAK_MIN_LENGTH = 2; // consecutive days played needed before the daily streak medal shows
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.4;
const CITY_CENTER = [62.3908, 17.3069];

// --- Optional final-round score modifier ---------------------------------
// At most ONE modifier type is available on any given day, decided ONCE at
// generation time (see pick_daily_modifier() in tools/generate_game.py) and
// baked into that day's published game file as game.modifier — never
// computed here from "whatever the client code happens to do today". This
// is the whole reason the feature can exist going forward without ever
// touching already-published days: old game files simply have no
// "modifier" key, dailyModifierType below reads back as null for them, and
// shouldOfferFinalModifier() always returns false as a result. See
// AGENTS.md for the full "never change the rules for old days" policy —
// read it before touching anything in this section.
//
// Even when a day does have a modifier available, it's only ever offered
// once, right before the FINAL round, and only to a player who scored 95+
// on every round so far (a perfect run) — so the game gets more intense as
// it goes, rather than being an early freebie. It's a single accept/skip
// choice, never a picker between multiple options. Purely a client-side
// scoring/timer effect for that one round — it never touches which
// locations/photos are shown, so every player still plays the exact same
// underlying daily game regardless of what they pick.
// Also fully backward compatible: it only ever adds new optional fields
// (modifierBonus/roundModifiers) to freshly-saved records; old saved scores
// (from before this existed) simply have none and are read back as 0/[].
const MODIFIER_DOUBLE_THRESHOLD = 80; // round score needed to "win" Double or Nothing
const MODIFIER_DOUBLE_SEED_BONUS = 10; // granted on a win when there was no existing pool to double
const MODIFIER_HARD_DECAY_METERS = 220; // steeper than the normal 450 -- much less forgiving
const MODIFIER_HARD_THRESHOLD = 65; // score (under that steeper decay) needed to bank the bonus
const MODIFIER_HARD_BONUS = 15;
const MODIFIER_QUICK_TIME_SECONDS = 30;
const MODIFIER_QUICK_THRESHOLD = 70;
const MODIFIER_QUICK_BONUS = 10;

const MODIFIER_INFO = {
  double: {
    icon: "🎲", label: "Double or Nothing",
    pitch: "Final round is Double or Nothing: score 80+ to double your modifier bonus pool, or lose it all.",
  },
  hard: {
    icon: "💀", label: "Hard Round",
    pitch: "Final round is a Hard Round: much steeper distance scoring, but score 65+ under it for a flat +15 bonus.",
  },
  quick: {
    icon: "⚡", label: "Quick Round",
    pitch: "Final round is a Quick Round: only 30 seconds on the clock, but score 70+ fast for a flat +10 bonus.",
  },
};

let dailyModifierType = null; // this day's available modifier ("double" /
                               // "hard" / "quick"), or null -- read straight
                               // from game.modifier, see loadGameForDate().
let finalModifierOffered = false; // guards against offering it twice in one
                                   // game (the offer only ever happens once,
                                   // right before the final round).
let modifierBonus = 0; // running bonus pool this game, added into finalScore
                        // uncapped (same "not capped at 100" philosophy as
                        // the medal bonus) -- reset in startGame().
let roundModifiers = []; // per-round modifier outcome, aligned by index with
                          // roundScores: { type, success, delta } or null.
let pendingModifierType = null; // modifier chosen for the round about to
                                 // load; consumed by loadRound().
let activeModifierType = null; // modifier actually in effect for the round
                                // currently being played; consumed/reset by
                                // makeGuess().
let currentRoundTimeLimit = ROUND_TIME_SECONDS; // actual time limit for the
                                                 // round in progress (120s
                                                 // normally, 30s for an
                                                 // active Quick Round).

let map, guessMarker, roundLocations, currentRoundIndex, roundScores, resultLayers;
let roundLocked = false; // true while the result panel is showing, so map
                          // clicks don't move the guess marker during review
let activeGameDate = null;
let manifestCache = null;
let currentShareSeed = null;
let currentShareCanvas = null;
let currentMedals = [];
let currentDailyStreak = 0;
let currentBestHotStreak = 0; // whichever run's showcase streak is on screen
                               // right now (live or a saved record) — used by
                               // the share card, set explicitly like
                               // currentShareScore, never recomputed.
let currentWorstColdStreak = 0; // same idea, for the roast badge.
let currentModifierBonus = 0; // total bonus banked via optional modifiers,
                               // same explicit-state pattern as the streak
                               // fields above (set by whichever flow — live
                               // or replay — currently owns the display).
let currentAttemptNumber = 1;
let roundTimerInterval = null;
let roundTimerRemaining = ROUND_TIME_SECONDS;
let hotStreak = 0;
let coldStreak = 0;
let bestHotStreak = 0; // longest hot streak reached this playthrough, for the
                        // final-card "showcase" badge
let worstColdStreak = 0; // longest cold streak reached this playthrough, for
                          // the final-card "roast" badge — shown deliberately
                          // so friends can clown on a bad run
let roundHardFlags = []; // per-round difficulty flag, aligned by index with
                          // roundScores/roundTimesTaken/roundZoomUsed. Used
                          // only internally (e.g. the "Hard Round Hero"
                          // medal) — never surfaced per-round in the UI,
                          // since "hard" is a design guess, not a verified
                          // fact about any individual round.

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
// a couple of km off should genuinely hurt. decayMeters is overridable so an
// active "Hard Round" modifier (see MODIFIER_HARD_DECAY_METERS) can apply a
// steeper falloff for just that one round without touching the base game.
function distanceToScore(distanceMeters, decayMeters = DISTANCE_DECAY_METERS) {
  if (distanceMeters <= PERFECT_DISTANCE_METERS) return 100;
  const raw = 100 * Math.exp(-Math.pow(distanceMeters / decayMeters, DISTANCE_SCORE_EXPONENT));
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

// Counts consecutive calendar days (ending at and including `date`) that
// have a saved score, using the same YYYY-MM-DD keys saved scores are
// stored under. Missing a day anywhere breaks the chain, so this rewards
// showing up daily rather than just playing a lot overall.
function computeDailyStreak(date, savedScores) {
  const saved = savedScores || loadSavedScores();
  let streak = 0;
  const cursor = new Date(`${date}T00:00:00Z`);
  while (saved[cursor.toISOString().slice(0, 10)]) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

// Only the FIRST time a given day's game is completed is the score kept —
// replays don't overwrite your official result for that day. A random seed
// is stored alongside it so the share-card background stays consistent
// whenever this score is viewed again later. hardFlags is kept purely for
// internal medal bookkeeping (never surfaced per-round in the UI).
// bestHotStreak/worstColdStreak capture the most impressive/embarrassing
// in-run streak reached, for the showcase/roast badges on the share card.
function saveFirstScoreIfMissing(date, score, scores, medals, hardFlags, bestHotStreak, worstColdStreak, modifierBonusTotal, modifiersUsed) {
  const saved = loadSavedScores();
  if (saved[date]) return { record: saved[date], justSaved: false };
  const seed = Math.floor(Math.random() * 1e9);
  const record = {
    score,
    roundScores: scores,
    recordedAt: new Date().toISOString(),
    seed,
    medals: medals || [],
    hardFlags: hardFlags || [],
    bestHotStreak: bestHotStreak || 0,
    worstColdStreak: worstColdStreak || 0,
    modifierBonus: modifierBonusTotal || 0,
    roundModifiers: modifiersUsed || []
  };
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
  // game.modifier is decided once, server-side, at generation time (see
  // pick_daily_modifier() in tools/generate_game.py) — never computed here
  // from "today's code". Days published before this feature existed simply
  // have no "modifier" key, which is exactly why they'll never offer one,
  // no matter how this client code changes later. See AGENTS.md.
  return { date, locations: game.locations, dailyModifierType: game.modifier || null };
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
  roundHardFlags[currentRoundIndex] = isHardRound;
  document.getElementById("photoPane").classList.toggle("hard-round", isHardRound);
  const areaHint = document.getElementById("roundAreaHint");
  areaHint.textContent = `📍 Area: ${roundAreaLabel(loc)}`;
  areaHint.classList.toggle("visible", !isHardRound && Boolean(roundAreaLabel(loc)));

  // Consume whatever modifier the player just picked (if any) from the
  // mid-round offer overlay -- it applies to this one round only.
  activeModifierType = pendingModifierType;
  pendingModifierType = null;
  const modifierBadge = document.getElementById("modifierBadge");
  if (modifierBadge) {
    const info = MODIFIER_INFO[activeModifierType];
    modifierBadge.textContent = info ? `${info.icon} ${info.label}` : "";
    modifierBadge.classList.toggle("hidden", !info);
  }

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
  currentRoundTimeLimit = activeModifierType === "quick" ? MODIFIER_QUICK_TIME_SECONDS : ROUND_TIME_SECONDS;
  roundTimerRemaining = currentRoundTimeLimit;
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
    const decayMeters = activeModifierType === "hard" ? MODIFIER_HARD_DECAY_METERS : DISTANCE_DECAY_METERS;
    points = distanceToScore(distance, decayMeters);
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
  roundTimesTaken.push(currentRoundTimeLimit - Math.max(0, roundTimerRemaining));
  roundZoomUsed.push(zoomUsedThisRound);

  const modifierResult = resolveModifier(points, guessMarker !== null);
  roundModifiers[currentRoundIndex] = modifierResult;
  activeModifierType = null;

  document.getElementById("resultTitle").textContent = loc.name;
  document.getElementById("resultDistance").textContent =
    timedOut && guessMarker ? `⏱ Time's up! Distance: ${distText}` : `Distance: ${distText}`;

  const pointsEl = document.getElementById("resultPoints");
  animateScoreCountUp(pointsEl, points, { suffix: ` / 100 ${scoreEmoji(points)}` });
  playScoreEffect(points);
  applyStreakVisuals();
  applyModifierResultVisuals(modifierResult);

  const isLastRound = currentRoundIndex === ROUND_COUNT - 1;
  document.getElementById("nextBtn").textContent = isLastRound ? "See Final Score" : "Next Round";

  document.getElementById("guessBtn").disabled = true;
  document.getElementById("resultOverlay").classList.remove("hidden");
  updateHud();
}

// Resolves whichever optional modifier was active for the round that just
// finished (if any) against its raw round score, updating the shared
// modifierBonus pool. Returns null when no modifier was active, or a
// {type, success, delta} record used both for the per-round result note and
// for the permanently-saved roundModifiers breakdown. A timeout or an
// unplaced guess always counts as a loss for whatever modifier was active —
// consistent with how a plain round with no guess just scores 0.
function resolveModifier(points, hadGuess) {
  if (!activeModifierType) return null;
  const won = hadGuess && points >= modifierWinThreshold(activeModifierType);

  if (activeModifierType === "double") {
    const before = modifierBonus;
    modifierBonus = won ? (before > 0 ? before * 2 : MODIFIER_DOUBLE_SEED_BONUS) : 0;
    return { type: "double", success: won, delta: modifierBonus - before };
  }

  const delta = won ? modifierFixedBonus(activeModifierType) : 0;
  modifierBonus += delta;
  return { type: activeModifierType, success: won, delta };
}

function modifierWinThreshold(type) {
  if (type === "double") return MODIFIER_DOUBLE_THRESHOLD;
  if (type === "hard") return MODIFIER_HARD_THRESHOLD;
  return MODIFIER_QUICK_THRESHOLD;
}

function modifierFixedBonus(type) {
  if (type === "hard") return MODIFIER_HARD_BONUS;
  if (type === "quick") return MODIFIER_QUICK_BONUS;
  return 0;
}

// Shows a plain-language success/fail callout for the round's modifier (if
// any) right under its points, so the resulting bonus (or loss) is never a
// mystery -- same "make the +numbers legible" goal as the medal/share-card
// breakdown.
function applyModifierResultVisuals(modifierResult) {
  const noteEl = document.getElementById("resultModifierNote");
  if (!noteEl) return;
  if (!modifierResult) {
    noteEl.textContent = "";
    noteEl.classList.add("hidden");
    noteEl.classList.remove("modifier-success", "modifier-fail");
    return;
  }
  const info = MODIFIER_INFO[modifierResult.type];
  const sign = modifierResult.delta > 0 ? "+" : "";
  const deltaText = `${sign}${modifierResult.delta}`;
  noteEl.textContent = modifierResult.success
    ? `${info.icon} ${info.label}: SUCCESS! (${deltaText} bonus)`
    : `${info.icon} ${info.label}: FAILED (${deltaText} bonus)`;
  noteEl.classList.remove("hidden");
  noteEl.classList.toggle("modifier-success", modifierResult.success);
  noteEl.classList.toggle("modifier-fail", !modifierResult.success);
}

// Tracks consecutive hot (>=95) or cold (<=20) rounds *within the current
// game*. Breaking a streak (a round that's neither) resets both counters.
// bestHotStreak/worstColdStreak remember the longest streak of each kind
// reached at any point this game, for the end-of-game showcase/roast badge
// — those don't reset when the in-progress streak breaks.
function updateStreaks(points) {
  if (points >= HOT_STREAK_SCORE) {
    hotStreak++;
    coldStreak = 0;
    bestHotStreak = Math.max(bestHotStreak, hotStreak);
  } else if (points <= COLD_STREAK_SCORE) {
    coldStreak++;
    hotStreak = 0;
    worstColdStreak = Math.max(worstColdStreak, coldStreak);
  } else {
    hotStreak = 0;
    coldStreak = 0;
  }
}

// Streak "levels" 1-4, one per possible streak length from STREAK_MIN_LENGTH
// (2) up to ROUND_COUNT (5 — a perfect run, every round hot or cold). Each
// level gets an increasingly intense gold (or gloomy) treatment so the
// visual keeps escalating round by round instead of capping out at "strong".
function streakLevel(length) {
  return Math.max(1, Math.min(4, length - STREAK_MIN_LENGTH + 1));
}

// Shows a gold shimmering border — getting shinier/faster at each streak
// length up to a perfect run — for a hot streak, or an increasingly gloomy
// "sad" border for a cold streak, on the per-round result popup. Also
// spawns a matching particle burst that scales with the same level.
function applyStreakVisuals() {
  const box = document.getElementById("resultBox");
  const badge = document.getElementById("streakBadge");
  box.classList.remove(
    "streak-gold-1", "streak-gold-2", "streak-gold-3", "streak-gold-4",
    "streak-sad-1", "streak-sad-2", "streak-sad-3", "streak-sad-4"
  );
  badge.classList.add("hidden");

  if (hotStreak >= STREAK_MIN_LENGTH) {
    const level = streakLevel(hotStreak);
    box.classList.add(`streak-gold-${level}`);
    badge.textContent = `✨ Hot streak x${hotStreak}!`;
    badge.classList.remove("hidden");
    launchStreakEffect("gold", level);
  } else if (coldStreak >= STREAK_MIN_LENGTH) {
    const level = streakLevel(coldStreak);
    box.classList.add(`streak-sad-${level}`);
    badge.textContent = `😢 Cold streak x${coldStreak}...`;
    badge.classList.remove("hidden");
    launchStreakEffect("sad", level);
  }
}

// Bonus points awarded per earned medal, added on top of the plain
// round-average score (capped back down to 100). Only applies to scores
// computed by a live playthrough right now — a previously saved/recorded
// score (from before this feature existed, or from any earlier day) is
// never recalculated or bumped after the fact. That keeps every day's
// official score permanently comparable to itself; only a brand-new
// playthrough (whether of today or of an old date nobody has played yet)
// uses the current bonus rules.
const MEDAL_BONUS_PER_MEDAL = 5;

// The score actually rendered on the share card / share button tier for
// whatever is currently on screen. Sourced explicitly by whichever flow
// currently owns it — nextRound() sets it to the freshly computed (and
// possibly medal-bonused) live score, showSavedScoreOverlay() sets it to
// the exact score that was permanently recorded for that day. Never
// recomputed implicitly, so a historical score can't accidentally drift.
let currentShareScore = 0;

// True once a score has been pushed past the normal 100 ceiling by stacking
// medal bonuses on a flawless run — the rare "SUNDMASTER" achievement.
// Same explicit-state pattern as currentShareScore: set by whichever flow
// currently owns the display, never inferred at render time.
let currentIsSundmaster = false;

// How far past 100 the score got, on a 0-3 scale (0 = not Sundmaster at all).
// Purely a bigger-number-means-crazier-visuals escalation on top of the
// existing SUNDMASTER achievement — same explicit-state pattern as
// currentIsSundmaster, set alongside it, never inferred at render time.
let currentSundmasterTier = 0;

function sundmasterTier(score) {
  if (score > 170) return 3;
  if (score > 130) return 2;
  if (score > 100) return 1;
  return 0;
}

const SUNDMASTER_TITLES = ["Game Over!", "🏆 SUNDMASTER!", "👑 SUPER SUNDMASTER!!", "🌈 ULTRA SUNDMASTER!!!"];

// Swaps the "Game Over!" heading for an increasingly over-the-top SUNDMASTER
// title (and toggles matching background flourishes) the further a score
// climbed past the normal 100 ceiling. Cheap DOM toggle, safe to call from
// both the live-finish and historical-replay paths.
function applyFinalTitle(tier) {
  const titleEl = document.getElementById("finalTitle");
  const boxEl = document.getElementById("finalBox");
  if (titleEl) titleEl.textContent = SUNDMASTER_TITLES[tier] || SUNDMASTER_TITLES[0];
  if (boxEl) {
    boxEl.classList.toggle("sundmaster", tier >= 1);
    boxEl.classList.toggle("sundmaster-tier2", tier >= 2);
    boxEl.classList.toggle("sundmaster-tier3", tier >= 3);
  }
}

function baseScoreValue() {
  return Math.round(roundScores.reduce((a, b) => a + b, 0) / roundScores.length);
}

// Speed/efficiency "medals" for the share card — only awarded on a decent
// score so a lucky-fast-but-terrible guess doesn't get rewarded. Based on
// average time taken per round and whether the photo was ever zoomed/panned.
// hardFlags/scores (both indexed the same way as times/zoomUsed) let a
// separate medal reward being fast AND accurate specifically on the hard
// round(s) of the day, which is a tougher bar than the overall averages.
function computeMedals(score, times, zoomUsed, hardFlags, scores) {
  if (!times || !times.length || score < 60) return [];
  const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
  const medals = [];
  if (avgTime <= 12) medals.push({ icon: "⚡", label: "Lightning Fast" });
  else if (avgTime <= 25) medals.push({ icon: "🏃", label: "Quick Guesser" });
  if (zoomUsed && zoomUsed.length && zoomUsed.every((z) => !z)) {
    medals.push({ icon: "🧭", label: "True Local" });
  }
  if (hardFlags && hardFlags.length && scores && scores.length) {
    const hardIndexes = hardFlags.reduce((acc, isHard, i) => {
      if (isHard) acc.push(i);
      return acc;
    }, []);
    const wasFastAndAccurate = hardIndexes.length > 0 &&
      hardIndexes.every((i) => times[i] <= 20 && scores[i] >= 70);
    if (wasFastAndAccurate) medals.push({ icon: "🔥", label: "Hard Round Hero" });
  }
  return medals;
}

function nextRound() {
  currentRoundIndex++;
  if (currentRoundIndex >= ROUND_COUNT) {
    document.getElementById("resultOverlay").classList.add("hidden");

    const baseScore = baseScoreValue();
    const medals = computeMedals(baseScore, roundTimesTaken, roundZoomUsed, roundHardFlags, roundScores);
    // Medal bonus + modifier bonus are only ever applied to a fresh live
    // playthrough happening right now — see the MEDAL_BONUS_PER_MEDAL
    // comment above. Deliberately NOT capped at 100 (in either direction):
    // stacking medals/modifiers on a flawless run can push well past 100,
    // which is the whole point — that's what unlocks (and escalates) the
    // SUNDMASTER title/celebration below. A plain 100 stays a plain 100.
    const finalScore = baseScore + medals.length * MEDAL_BONUS_PER_MEDAL + modifierBonus;
    const tier = sundmasterTier(finalScore);

    const finalScoreEl = document.getElementById("finalScore");
    animateScoreCountUp(finalScoreEl, finalScore, {
      prefix: "Final Score: ",
      suffix: ` / 100 ${scoreEmoji(finalScore)}${finalScore === 0 ? " 🥀" : ""}`
    });
    playScoreEffect(finalScore);
    // Extra celebratory burst that keeps escalating with the tier, on top
    // of the standard great-score confetti playScoreEffect already fired.
    if (tier >= 2) launchConfetti(50 + tier * 40);

    renderRoundBreakdown();
    renderScoreBreakdownNote(finalScore, baseScore, medals.length, modifierBonus);

    currentAttemptNumber = bumpAttempt(activeGameDate);
    const { record, justSaved } = saveFirstScoreIfMissing(
      activeGameDate, finalScore, roundScores, medals, roundHardFlags, bestHotStreak, worstColdStreak,
      modifierBonus, roundModifiers
    );
    // The share card always reflects the attempt actually being displayed
    // right now — the fresh finalScore/medals/streaks just computed above —
    // never the old frozen record, even on a replay. Only the permanently
    // saved *official* score (record.score, shown in firstScoreNote below)
    // stays pinned to whatever was first recorded for this day. The "Nth
    // TRY" stamp on the card (driven by currentAttemptNumber) is what makes
    // clear a replay's card isn't the official result, so showing the real
    // fresh numbers here is safe and expected.
    currentShareSeed = record.seed;
    currentMedals = medals;
    currentShareScore = finalScore;
    currentModifierBonus = modifierBonus;
    currentBestHotStreak = bestHotStreak || 0;
    currentWorstColdStreak = worstColdStreak || 0;
    currentDailyStreak = computeDailyStreak(activeGameDate);
    currentSundmasterTier = tier;
    currentIsSundmaster = tier >= 1;
    applyFinalTitle(tier);
    updateShareCardPreview();
    updateShareBtnTier(currentShareScore);
    document.getElementById("finalOverlay").classList.remove("hidden");

    const noteEl = document.getElementById("firstScoreNote");
    noteEl.textContent = justSaved
      ? "Saved as your official score for this day!"
      : `Your official score for this day was already recorded: ${record.score}/100.`;

    populateDatePicker(manifestCache, activeGameDate);
    updateViewScoreButton();
  } else if (shouldOfferFinalModifier()) {
    document.getElementById("resultOverlay").classList.add("hidden");
    showFinalModifierOverlay();
  } else {
    loadRound();
  }
}

// The final-round modifier offer requires ALL of:
//  - this day actually has one available (dailyModifierType, decided
//    server-side at generation time — see the big comment above it)
//  - it hasn't already been offered this game
//  - the upcoming round is the LAST one (round count intensifies toward the
//    end, never an early freebie)
//  - the player scored 95+ on every round so far (a perfect run) — see
//    HOT_STREAK_SCORE
function shouldOfferFinalModifier() {
  if (!dailyModifierType || finalModifierOffered) return false;
  if (currentRoundIndex !== ROUND_COUNT - 1) return false;
  if (roundScores.length !== ROUND_COUNT - 1) return false;
  return roundScores.every((score) => score >= HOT_STREAK_SCORE);
}

function showFinalModifierOverlay() {
  finalModifierOffered = true;
  const info = MODIFIER_INFO[dailyModifierType];
  const subtitleEl = document.getElementById("modifierSubtitle");
  if (subtitleEl) subtitleEl.textContent = info.pitch;
  const acceptBtn = document.getElementById("modifierAcceptBtn");
  if (acceptBtn) acceptBtn.textContent = `${info.icon} Accept: ${info.label}`;
  document.getElementById("modifierOverlay").classList.remove("hidden");
}

function hideModifierOverlay() {
  document.getElementById("modifierOverlay").classList.add("hidden");
}

// accept=true applies today's single available modifier to the final
// round; accept=false (skip) plays it exactly as normal.
function chooseModifier(accept) {
  pendingModifierType = accept ? dailyModifierType : null;
  hideModifierOverlay();
  loadRound();
}

function renderRoundBreakdown() {
  const list = document.getElementById("roundBreakdown");
  list.innerHTML = "";
  roundScores.forEach((s, i) => {
    const li = document.createElement("li");
    const mod = roundModifiers[i];
    let text = `Round ${i + 1}: ${s} / 100`;
    if (mod) {
      const info = MODIFIER_INFO[mod.type];
      const sign = mod.delta > 0 ? "+" : "";
      text += ` (${info.label}: ${mod.success ? "success" : "failed"}, ${sign}${mod.delta} bonus)`;
    }
    li.textContent = text;
    list.appendChild(li);
  });
}

// Screen-reader-accessible plain-text version of the "Base + medals +
// modifiers = total" breakdown drawn on the share card canvas (see
// drawShareCanvas) — same "make the +numbers legible" goal, just for
// anyone not looking at the image. Blank when there's nothing to explain
// (a plain score with no bonuses at all).
function renderScoreBreakdownNote(finalScore, baseScore, medalCount, modifierBonusTotal) {
  const el = document.getElementById("scoreBreakdownNote");
  if (!el) return;
  const parts = [];
  if (medalCount > 0) parts.push(`${medalCount} medal${medalCount > 1 ? "s" : ""} (+${medalCount * MEDAL_BONUS_PER_MEDAL})`);
  if (modifierBonusTotal) parts.push(`modifiers (${modifierBonusTotal > 0 ? "+" : ""}${modifierBonusTotal})`);
  el.textContent = parts.length
    ? `Score breakdown: ${baseScore} base + ${parts.join(" + ")} = ${finalScore}.`
    : "";
}

// Re-displays a previously saved (first) score for the given day, e.g. after
// accidentally closing the final overlay. Does not re-save or affect the
// in-progress round state, and — critically — never recomputes the score:
// it always shows exactly what was permanently recorded for that day, so
// old days stay comparable to themselves even as the live scoring rules
// (like the medal bonus) evolve.
function showSavedScoreOverlay(date) {
  const record = getSavedScore(date);
  if (!record) return;

  roundScores = record.roundScores;
  roundHardFlags = record.hardFlags || [];
  roundModifiers = record.roundModifiers || [];
  modifierBonus = record.modifierBonus || 0;
  currentShareSeed = typeof record.seed === "number" ? record.seed : hashSeed(`${date}:${record.score}`);
  currentMedals = record.medals || [];
  currentShareScore = record.score;
  currentModifierBonus = modifierBonus;
  currentBestHotStreak = record.bestHotStreak || 0;
  currentWorstColdStreak = record.worstColdStreak || 0;
  currentDailyStreak = computeDailyStreak(date);
  currentSundmasterTier = sundmasterTier(record.score);
  currentIsSundmaster = currentSundmasterTier >= 1;
  currentAttemptNumber = 1; // viewing the official recorded result, not a new attempt

  applyFinalTitle(currentSundmasterTier);
  document.getElementById("finalScore").textContent =
    `Final Score: ${record.score} / 100 ${scoreEmoji(record.score)}${record.score === 0 ? " 🥀" : ""}`;
  renderRoundBreakdown();
  renderScoreBreakdownNote(record.score, baseScoreValue(), currentMedals.length, modifierBonus);
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

  const shareScore = currentShareScore;
  const theme = themeForScore(shareScore);
  paintShareBackground(ctx, theme, W, H, shareScore, activeGameDate);

  const baseScore = baseScoreValue();
  const medalBonusTotal = currentMedals.length * MEDAL_BONUS_PER_MEDAL;
  const tier = currentSundmasterTier;

  // SUNDMASTER: a flawless run stacked with medal/modifier bonuses pushed
  // the score past the normal 100 ceiling. Tile the Medelpad coat-of-arms
  // icon (plus a couple of celebratory emoji) scattered across the card at
  // low opacity, seeded by date so re-sharing the same day's card always
  // looks identical -- density/opacity escalate with the tier (see
  // sundmasterTier()) so a truly ridiculous score reads as truly
  // ridiculous. Drawn after the themed background but before any text, so
  // it reads as festive texture rather than obscuring the score.
  if (tier >= 1) {
    paintSundmasterOverlay(ctx, W, H, headerIconImg, activeGameDate || String(shareScore), tier);
  }

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

  ctx.font = tier >= 1 ? "bold 16px sans-serif" : "16px sans-serif";
  ctx.fillStyle = tier >= 1 ? "#ffd166" : "#c9d6e3";
  ctx.fillText(
    activeGameDate
      ? (tier >= 1 ? `${SUNDMASTER_TITLES[tier]} · ${activeGameDate}` : `Game of ${activeGameDate}`)
      : "",
    28,
    78
  );

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
  const finalScore = currentShareScore;
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
  if (finalScore === 0) {
    // A total zero gets an extra wilted rose right next to the tier emoji
    // (which is already 🥀 for any "terrible" score) to make an actual
    // goose-egg unmistakably, comedically worse than merely "bad".
    ctx.font = "40px sans-serif";
    ctx.fillText("🥀", 395, 150);
  }

  // Plain-number "why isn't this just my round average" breakdown, so a
  // score like 110/100 (or -15/100) never reads as a bug — only drawn when
  // there's actually something to explain. Deliberately just the raw
  // numbers being added (e.g. "74 + 10 = 84"), not labelled sub-totals like
  // "74 base + medals +10" — the medal/modifier pills elsewhere on the
  // card already explain *what* each bonus is; this line only needs to
  // show the arithmetic.
  if (medalBonusTotal > 0 || currentModifierBonus !== 0) {
    const parts = [`${baseScore}`];
    if (medalBonusTotal > 0) parts.push(`+ ${medalBonusTotal}`);
    if (currentModifierBonus !== 0) parts.push(`${currentModifierBonus > 0 ? "+" : "-"} ${Math.abs(currentModifierBonus)}`);
    ctx.font = "13px sans-serif";
    ctx.fillStyle = "#e8f0ff";
    ctx.fillText(`${parts.join(" ")} = ${finalScore}`, 28, 190);
  }

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

  // Speed/efficiency medal badges, modifier outcome badges, the daily
  // play-streak badge, and the in-game hot/cold streak badges — all drawn
  // as the same style of pill, sitting between the round breakdown and the
  // footer link. Every pill that actually contributed to the score shows
  // its exact +/-N so a total like 110/100 (or a negative score) is never a
  // mystery. The "showcase" hot-streak pill gets a warm gold-tinted
  // background to celebrate a great run; the "roast" cold-streak pill
  // deliberately gets a loud red-tinted background so a bad run stands out
  // and friends can have a laugh at it.
  const NORMAL_PILL_BG = "rgba(0, 0, 0, 0.4)";
  const GOLD_PILL_BG = "rgba(255, 179, 71, 0.35)";
  const ROAST_PILL_BG = "rgba(220, 50, 50, 0.45)";
  const badgePills = currentMedals.map((medal) => ({
    label: `${medal.icon} ${medal.label} (+${MEDAL_BONUS_PER_MEDAL})`,
    bg: NORMAL_PILL_BG,
  }));
  roundModifiers.forEach((mod) => {
    if (!mod) return;
    const info = MODIFIER_INFO[mod.type];
    const deltaText = `${mod.delta > 0 ? "+" : ""}${mod.delta}`;
    badgePills.push({
      label: `${info.icon} ${info.label} (${deltaText})`,
      bg: mod.success ? GOLD_PILL_BG : ROAST_PILL_BG,
    });
  });
  if (currentBestHotStreak >= STREAK_MIN_LENGTH) {
    badgePills.push({ label: `✨ Streak x${currentBestHotStreak}`, bg: GOLD_PILL_BG });
  }
  if (currentWorstColdStreak >= STREAK_MIN_LENGTH) {
    badgePills.push({ label: `🥶 Ice Cold x${currentWorstColdStreak}`, bg: ROAST_PILL_BG });
  }
  if (currentDailyStreak >= DAILY_STREAK_MIN_LENGTH) {
    badgePills.push({ label: `🔥 ${currentDailyStreak} Day Streak`, bg: NORMAL_PILL_BG });
  }
  if (badgePills.length) {
    let mx = 28;
    const my = 284;
    ctx.font = "bold 13px sans-serif";
    badgePills.forEach(({ label, bg }) => {
      const textW = ctx.measureText(label).width;
      const pillW = textW + 22;
      drawRoundedRect(ctx, mx, my, pillW, 24, 12);
      ctx.fillStyle = bg;
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
// text/plain entry. There's no reliable browser-side workaround for that —
// it's a Firefox bug, not something a website can detect or fix — so we
// just try the standard clipboard write and let Firefox catch up on its own
// end; everywhere else (Chrome/Brave/Samsung Internet/desktop) this works
// correctly today.
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

    try {
      if (navigator.clipboard && window.ClipboardItem) {
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
      }
      throw new Error("Clipboard image API not supported");
    } catch (err) {
      // Falls through to the download fallback below.
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
  document.getElementById("modifierOverlay").classList.add("hidden");
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

    const { locations, dailyModifierType: gameDailyModifierType } = await loadGameForDate(date);
    activeGameDate = date;
    // Order matters: generate_game.py deliberately orders rounds
    // easy -> medium -> ... -> hard, so no client-side shuffle here.
    roundLocations = locations;
    dailyModifierType = gameDailyModifierType;
    currentRoundIndex = 0;
    roundScores = [];
    roundTimesTaken = [];
    roundZoomUsed = [];
    roundHardFlags = [];
    hotStreak = 0;
    coldStreak = 0;
    bestHotStreak = 0;
    worstColdStreak = 0;
    modifierBonus = 0;
    roundModifiers = [];
    finalModifierOffered = false;
    pendingModifierType = null;
    activeModifierType = null;
    currentRoundTimeLimit = ROUND_TIME_SECONDS;
    currentShareSeed = null;
    currentMedals = [];
    currentModifierBonus = 0;
    currentBestHotStreak = 0;
    currentWorstColdStreak = 0;
    currentDailyStreak = 0;
    currentIsSundmaster = false;
    currentSundmasterTier = 0;
    applyFinalTitle(0);
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
  document.getElementById("modifierAcceptBtn").addEventListener("click", () => chooseModifier(true));
  document.getElementById("modifierSkipBtn").addEventListener("click", () => chooseModifier(false));
});
