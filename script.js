// SundGuesser - simple GeoGuessr-like prototype for Sundsvall
const TOTAL_ROUNDS = 5;
const MAX_POINTS = 1000;

let map, guessMarker, roundLocations, currentRoundIndex, score, resultLayers;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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

function initMap() {
  map = L.map("map").setView([62.392, 17.307], 12);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    subdomains: "abcd",
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

function startGame() {
  roundLocations = shuffle(LOCATIONS).slice(0, TOTAL_ROUNDS);
  currentRoundIndex = 0;
  score = 0;
  document.getElementById("finalOverlay").classList.add("hidden");
  updateHud();
  loadRound();
}

function updateHud() {
  document.getElementById("roundInfo").textContent = `Round ${currentRoundIndex + 1} / ${TOTAL_ROUNDS}`;
  document.getElementById("scoreInfo").textContent = `Score: ${score}`;
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
  const points = Math.round(MAX_POINTS * Math.exp(-distance / 3000));
  score += points;

  // Show actual location + line between guess and actual
  const actualMarker = L.marker([loc.lat, loc.lng], {
    icon: L.divIcon({ className: "actual-marker", html: "📍", iconSize: [24, 24] })
  }).addTo(map);
  const line = L.polyline([guessLatLng, [loc.lat, loc.lng]], { color: "red", dashArray: "5,5" }).addTo(map);
  resultLayers = [actualMarker, line];
  map.fitBounds(line.getBounds(), { padding: [60, 60] });

  document.getElementById("resultTitle").textContent = loc.name;
  const distText = distance >= 1000 ? `${(distance / 1000).toFixed(2)} km` : `${Math.round(distance)} m`;
  document.getElementById("resultDistance").textContent = `Distance: ${distText}`;
  document.getElementById("resultPoints").textContent = `+${points} points`;
  document.getElementById("guessBtn").disabled = true;
  document.getElementById("resultOverlay").classList.remove("hidden");
  updateHud();
}

function nextRound() {
  currentRoundIndex++;
  if (currentRoundIndex >= TOTAL_ROUNDS) {
    document.getElementById("resultOverlay").classList.add("hidden");
    document.getElementById("finalScore").textContent = `Final Score: ${score} / ${MAX_POINTS * TOTAL_ROUNDS}`;
    document.getElementById("finalOverlay").classList.remove("hidden");
  } else {
    loadRound();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  startGame();
  document.getElementById("guessBtn").addEventListener("click", makeGuess);
  document.getElementById("nextBtn").addEventListener("click", nextRound);
  document.getElementById("restartBtn").addEventListener("click", startGame);
});
