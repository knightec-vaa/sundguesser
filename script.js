// SundGuesser - Sundsvall GeoGuessr-like game
// Daily games are fetched pre-encrypted from data/games/<date>.enc.json and
// decrypted client-side using the key injected into config.js at deploy time.
const ROUND_COUNT = 5;
const DISTANCE_DECAY_METERS = 2000; // controls how quickly score falls off with distance
const PERFECT_DISTANCE_METERS = 25; // guesses this close are treated as a perfect 100

let map, guessMarker, roundLocations, currentRoundIndex, roundScores, resultLayers;
let activeGameDate = null;

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
function distanceToScore(distanceMeters) {
  if (distanceMeters <= PERFECT_DISTANCE_METERS) return 100;
  const raw = 100 * Math.exp(-distanceMeters / DISTANCE_DECAY_METERS);
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

async function pickGameDate(manifest) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const available = (manifest.dates || []).filter((d) => d <= todayStr).sort();
  if (available.length === 0) return null;
  return available[available.length - 1];
}

async function loadTodaysGame() {
  // data/games/<date>.json only exists in the deployed/dev build — it's produced
  // by decrypting data/games/<date>.enc.json inside CI (tools/decrypt_for_deploy.py).
  // The source repo only ever contains the encrypted version.
  const manifestRes = await fetch("data/manifest.json", { cache: "no-store" });
  if (!manifestRes.ok) throw new Error("No games published yet.");
  const manifest = await manifestRes.json();
  const date = await pickGameDate(manifest);
  if (!date) throw new Error("No games available yet. Check back on a weekday!");
  const gameRes = await fetch(`data/games/${date}.json`, { cache: "no-store" });
  if (!gameRes.ok) throw new Error(`Failed to load game for ${date}.`);
  const game = await gameRes.json();
  return { date, locations: game.locations };
}

function updateHud() {
  document.getElementById("roundInfo").textContent = `Round ${currentRoundIndex + 1} / ${ROUND_COUNT}`;
  const avg =
    roundScores.length > 0 ? Math.round(roundScores.reduce((a, b) => a + b, 0) / roundScores.length) : 0;
  document.getElementById("scoreInfo").textContent = `Score: ${avg}/100`;
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
  updateHud();
}

function makeGuess() {
  if (!guessMarker) return;
  const loc = roundLocations[currentRoundIndex];
  const guessLatLng = guessMarker.getLatLng();
  const distance = haversineDistance(guessLatLng.lat, guessLatLng.lng, loc.lat, loc.lng);
  const points = distanceToScore(distance);
  roundScores.push(points);

  const actualMarker = L.marker([loc.lat, loc.lng], {
    icon: L.divIcon({ className: "actual-marker", html: "📍", iconSize: [24, 24] })
  }).addTo(map);
  const line = L.polyline([guessLatLng, [loc.lat, loc.lng]], { color: "red", dashArray: "5,5" }).addTo(map);
  resultLayers = [actualMarker, line];
  map.fitBounds(line.getBounds(), { padding: [60, 60] });

  document.getElementById("resultTitle").textContent = loc.name;
  const distText = distance >= 1000 ? `${(distance / 1000).toFixed(2)} km` : `${Math.round(distance)} m`;
  document.getElementById("resultDistance").textContent = `Distance: ${distText}`;
  document.getElementById("resultPoints").textContent = `${points} / 100`;
  document.getElementById("guessBtn").disabled = true;
  document.getElementById("resultOverlay").classList.remove("hidden");
  updateHud();
}

function finalScoreValue() {
  return Math.round(roundScores.reduce((a, b) => a + b, 0) / roundScores.length);
}

function nextRound() {
  currentRoundIndex++;
  if (currentRoundIndex >= ROUND_COUNT) {
    document.getElementById("resultOverlay").classList.add("hidden");
    const finalScore = finalScoreValue();
    document.getElementById("finalScore").textContent = `Final Score: ${finalScore} / 100`;
    renderRoundBreakdown();
    document.getElementById("finalOverlay").classList.remove("hidden");
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

function drawShareCanvas() {
  const canvas = document.createElement("canvas");
  const W = 600, H = 340;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#1e3a5f");
  grad.addColorStop(1, "#274472");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 30px sans-serif";
  ctx.fillText("🧭 SundGuesser", 28, 50);

  ctx.font = "16px sans-serif";
  ctx.fillStyle = "#c9d6e3";
  ctx.fillText(activeGameDate ? `Game of ${activeGameDate}` : "", 28, 78);

  ctx.font = "bold 72px sans-serif";
  ctx.fillStyle = "#ffd166";
  const finalScore = finalScoreValue();
  ctx.fillText(`${finalScore}/100`, 28, 165);

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

  return canvas;
}

async function shareResult() {
  const canvas = drawShareCanvas();
  const status = document.getElementById("shareStatus");
  canvas.toBlob(async (blob) => {
    if (!blob) return;
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        status.textContent = "Copied to clipboard! Paste it into Slack or Discord.";
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

async function startGame() {
  document.getElementById("finalOverlay").classList.add("hidden");
  document.getElementById("shareStatus").textContent = "";
  try {
    const { date, locations } = await loadTodaysGame();
    activeGameDate = date;
    roundLocations = shuffle(locations);
    currentRoundIndex = 0;
    roundScores = [];
    updateHud();
    loadRound();
  } catch (err) {
    console.error(err);
    showFatalError(err.message || "Failed to load today's game.");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  startGame();
  document.getElementById("guessBtn").addEventListener("click", makeGuess);
  document.getElementById("nextBtn").addEventListener("click", nextRound);
  document.getElementById("restartBtn").addEventListener("click", startGame);
  document.getElementById("shareBtn").addEventListener("click", shareResult);
});
