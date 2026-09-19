#!/usr/bin/env python3
"""Auto-source new game locations from KartaView (kartaview.org), a free,
no-API-key street-level imagery service with real GPS-tagged photos.

Queries a grid of points across Sundsvall, picks well-spaced candidate
photos, reverse-geocodes a human-readable name via OpenStreetMap Nominatim,
runs a best-effort automated quality gate (rejects corrupt/blank images and
candidates with no resolvable road name), downloads and compresses each
surviving photo (see tools/image_utils.py), and appends the result to
secrets/locations.json (the plaintext master pool) with the image bytes
embedded as base64 (imgData/imgExt) — this is what actually gets served to
players (self-hosted from the repo, not hotlinked), so the game keeps
working even if KartaView is ever slow/down/reorganized.

This supplements (does not replace) manually curated locations. Note: the
automated quality gate can't judge whether a photo is a *visually
interesting* landmark vs. a boring stretch of road — that needs a human or a
vision model — so it optimizes for "not broken" rather than "great photo".
Run by .github/workflows/fetch-locations.yml on a schedule; also runnable
locally.

Usage:
    python3 tools/fetch_kartaview_locations.py --count 30
    python3 tools/build_pool.py   # re-encrypt after reviewing additions
"""
import argparse
import io
import json
import math
import random
import time
import urllib.error
import urllib.request

from crypto_lib import REPO_ROOT, SECRETS_DIR
from image_utils import fetch_and_compress

POOL_PLAINTEXT = SECRETS_DIR / "locations.json"
REJECTED_FILE = REPO_ROOT / "data" / "rejected_kartaview.json"

KARTAVIEW_API = "https://api.openstreetcam.org/2.0/photo/"
NOMINATIM_API = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "SundGuesser/1.0 (lunch-time geoguesser prototype)"

MIN_CONTRAST_STDDEV = 18  # rejects near-blank/foggy/corrupt images

# Grid of query points spread across central/greater Sundsvall. Deliberately
# wider than just the city core so repeated automated runs (see the
# fetch-locations workflow) have new ground to explore over time instead of
# immediately re-finding the same handful of central photos.
GRID_POINTS = [
    (62.3908, 17.3069), (62.3925, 17.3055), (62.3880, 17.3100),
    (62.3950, 17.2950), (62.3860, 17.3150), (62.3800, 17.2800),
    (62.4000, 17.3200), (62.3890, 17.2900), (62.3960, 17.3100),
    (62.3830, 17.3050), (62.3915, 17.3150), (62.3870, 17.2950),
    (62.3940, 17.3000), (62.3820, 17.3200), (62.3990, 17.3050),
    (62.3970, 17.2900), (62.3780, 17.3000), (62.3900, 17.3250),
    (62.3850, 17.2850), (62.4020, 17.3100), (62.3760, 17.2900),
    (62.3930, 17.3200), (62.3810, 17.3120), (62.3980, 17.3300),
    # Greater Sundsvall / outer districts.
    (62.3600, 17.2600),  # Skönsberg / Sidsjön
    (62.4100, 17.2600),  # Skönsmon
    (62.3700, 17.3600),  # Bergsåker
    (62.4200, 17.3500),  # Njurundabommen direction
    (62.3550, 17.3200),  # Korsta
    (62.4300, 17.2900),  # Granloholm
    (62.3450, 17.2900),  # Nacksta
    (62.4000, 17.2400),  # Fläsian / Västermalm
    (62.3800, 17.4000),  # Ortviken
    # Alnö (island district) gets a few extra points since it's easy to
    # under-sample otherwise — bridge landing, the church/Vi area, and
    # further out towards Spikbodarna.
    (62.4536, 17.4271),  # Alnö (general)
    (62.4180, 17.3700),  # Alnö bridge landing
    (62.4750, 17.4050),  # Alnö, Vi / church area
    (62.4900, 17.4400),  # Alnö, Spikbodarna direction
    # A light sprinkling of neighbouring municipalities for variety. Kept
    # deliberately sparse relative to the Sundsvall core above so the city
    # remains the main focus, with just a taste of Timrå/Matfors/Njurunda.
    (62.4950, 17.3350),  # Timrå centrum
    (62.4700, 17.3600),  # Timrå / Söråker direction
    (62.4600, 17.3450),  # Vivsta (Timrå)
    (62.4280, 17.3450),  # Birsta (in between Sundsvall and Timrå)
    (62.3540, 16.9800),  # Matfors
    (62.3020, 17.3800),  # Njurunda
    (62.2850, 17.4100),  # Njurunda / Stavre direction
    (62.2700, 17.3300),  # Kvissleby
    (62.3350, 17.2350),  # Sundsbruk
]

MIN_SPACING_METERS = 120  # avoid near-duplicate photos of the same spot


def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read())


def query_kartaview(lat, lng, radius=300):
    url = f"{KARTAVIEW_API}?lat={lat}&lng={lng}&radius={radius}"
    try:
        data = fetch_json(url)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return []
    return data.get("result", {}).get("data") or []


def reverse_geocode(lat, lng):
    """Returns (name, has_road_name). A missing road name usually means the
    point is off-road / out in the sticks / low-context for a guessing game,
    so callers can use it as an extra automated quality signal.
    """
    url = f"{NOMINATIM_API}?format=json&lat={lat}&lon={lng}&zoom=17&addressdetails=1"
    try:
        data = fetch_json(url)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None, False
    addr = data.get("address", {})
    road = addr.get("road") or addr.get("pedestrian") or addr.get("neighbourhood")
    suburb = addr.get("suburb") or addr.get("city_district") or addr.get("city")
    if road and is_generic_highway(road):
        # Numbered highways (E4, Rv86, ...) look the same for miles and give
        # away nothing distinctive — treat like "no usable road name".
        road = None
    if road and suburb and road != suburb:
        return f"{road}, {suburb}", True
    if road:
        return road, True
    return suburb or data.get("display_name", "").split(",")[0], False


def is_generic_highway(road_name):
    import re
    return bool(re.match(r"^(E ?\d+|Rv ?\d+|Länsväg ?\d+)$", road_name.strip(), re.IGNORECASE))


def image_url(photo):
    # LTh ("large thumb") variant is a decent 1280x720 JPEG, reliably hosted.
    return photo.get("fileurlLTh") or photo.get("fileurl", "").replace("{{sizeprefix}}", "lth")


def fetch_and_check_image(img_url):
    """Downloads the image once and returns (raw_bytes, ok) — ok is False if
    the image is corrupt/truncated/near-blank (fog/glare/sky-only shots with
    no useful landmarks) or couldn't be downloaded. Returning the raw bytes
    alongside the verdict lets the caller reuse the same download to build
    the self-hosted, compressed copy instead of fetching twice. If Pillow
    isn't available, skips the quality check (accepts anything downloadable).
    """
    try:
        raw = urllib.request.urlopen(
            urllib.request.Request(img_url, headers={"User-Agent": USER_AGENT}), timeout=20
        ).read()
    except Exception:
        return None, False

    try:
        from PIL import Image, ImageStat
    except ImportError:
        return raw, True

    try:
        img = Image.open(io.BytesIO(raw))
        img.verify()
        img = Image.open(io.BytesIO(raw)).convert("L").resize((160, 90))
        stddev = ImageStat.Stat(img).stddev[0]
        return raw, stddev >= MIN_CONTRAST_STDDEV
    except Exception:
        return raw, False


SWEDISH_TRANSLIT = str.maketrans({"å": "a", "ä": "a", "ö": "o", "é": "e", "ü": "u"})


def slugify(name):
    import re
    ascii_name = name.lower().translate(SWEDISH_TRANSLIT)
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name).strip("-")
    return slug or "kartaview-spot"


def load_pool():
    if POOL_PLAINTEXT.exists():
        return json.loads(POOL_PLAINTEXT.read_text())
    return []


def save_pool(pool):
    SECRETS_DIR.mkdir(exist_ok=True)
    POOL_PLAINTEXT.write_text(json.dumps(pool, indent=2, ensure_ascii=False) + "\n")


def load_rejected():
    """Permanent memory of photos previously judged low-quality (by a human
    or a prior automated pass), keyed by their KartaView image URL. This
    file is not sensitive (just public KartaView URLs) and is committed to
    the repo so the fetcher never re-proposes the same bad spot twice.
    """
    if REJECTED_FILE.exists():
        return set(json.loads(REJECTED_FILE.read_text()).get("rejected_img_urls", []))
    return set()


def save_rejected(rejected_urls):
    REJECTED_FILE.parent.mkdir(exist_ok=True)
    REJECTED_FILE.write_text(
        json.dumps({"rejected_img_urls": sorted(rejected_urls)}, indent=2) + "\n"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=30, help="how many new locations to add")
    parser.add_argument("--dry-run", action="store_true", help="print candidates, don't write")
    parser.add_argument(
        "--require-road-name", action="store_true", default=True,
        help="skip candidates Nominatim can't tie to a real road (default: on)",
    )
    parser.add_argument(
        "--no-require-road-name", dest="require_road_name", action="store_false",
    )
    parser.add_argument(
        "--skip-image-check", action="store_true",
        help="skip the automated blank/corrupt image quality gate",
    )
    parser.add_argument(
        "--reject", metavar="IMG_URL", action="append", default=[],
        help="permanently blocklist an image URL (can repeat) and exit",
    )
    args = parser.parse_args()

    rejected = load_rejected()
    if args.reject:
        rejected.update(args.reject)
        save_rejected(rejected)
        print(f"Added {len(args.reject)} URL(s) to the permanent rejection list ({REJECTED_FILE}).")
        return

    pool = load_pool()
    existing_coords = [(loc["lat"], loc["lng"]) for loc in pool]
    existing_ids = {loc["id"] for loc in pool}

    print(f"Querying KartaView across {len(GRID_POINTS)} grid points in Sundsvall...")
    candidates = []
    seen_ids = set()
    for lat, lng in GRID_POINTS:
        photos = query_kartaview(lat, lng)
        for p in photos:
            pid = p.get("id")
            if pid in seen_ids:
                continue
            seen_ids.add(pid)
            try:
                plat, plng = float(p["lat"]), float(p["lng"])
            except (KeyError, ValueError, TypeError):
                continue
            candidates.append({"id": pid, "lat": plat, "lng": plng, "photo": p})
        time.sleep(0.5)

    print(f"Found {len(candidates)} unique candidate photos.")

    # Single streaming pass: keep spatial spacing, reverse-geocode, and run
    # the automated image quality gate together, so a rejected candidate
    # doesn't waste its "spacing slot" and block a nearby good one.
    new_entries = []
    known_coords = list(existing_coords)
    checked = 0
    image_downloads = 0
    delay_rng = random.SystemRandom()
    for c in candidates:
        if len(new_entries) >= args.count:
            break
        lat, lng, photo = c["lat"], c["lng"], c["photo"]

        too_close = any(
            haversine_m(lat, lng, klat, klng) < MIN_SPACING_METERS
            for klat, klng in known_coords
        )
        if too_close:
            continue

        img = image_url(photo)
        if not img:
            continue
        if img in rejected:
            continue

        checked += 1
        name, has_road = reverse_geocode(lat, lng)
        time.sleep(1)  # Nominatim usage policy: max 1 req/sec
        if args.require_road_name and not has_road:
            print(f"  - skip (no road name): {name or 'unknown'} ({lat:.5f},{lng:.5f})")
            continue
        name = name or "Sundsvall"

        if image_downloads:
            delay = delay_rng.randint(60, 300)
            print(
                f"  - waiting {delay // 60}m {delay % 60}s before the next image download"
            )
            time.sleep(delay)

        raw_bytes = None
        if not args.skip_image_check:
            raw_bytes, ok = fetch_and_check_image(img)
            image_downloads += 1
            if not ok:
                print(f"  - skip (failed image quality check): {name} ({lat:.5f},{lng:.5f})")
                continue

        try:
            img_data, img_ext = fetch_and_compress(img, raw=raw_bytes)
            if args.skip_image_check:
                image_downloads += 1
        except Exception as exc:
            print(f"  - skip (failed to download/compress image): {name} ({exc})")
            continue

        known_coords.append((lat, lng))

        base_id = f"kv-{slugify(name)}"
        loc_id = base_id
        suffix = 2
        while loc_id in existing_ids:
            loc_id = f"{base_id}-{suffix}"
            suffix += 1
        existing_ids.add(loc_id)

        entry = {
            "id": loc_id,
            "name": name,
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            # Self-hosted, compressed copy of the photo — this is what the
            # game actually serves (see tools/decrypt_for_deploy.py). "img"
            # is kept only as provenance/audit metadata, never read by the
            # client.
            "imgData": img_data,
            "imgExt": img_ext,
            "img": img,
            "used": False,
            "usedInGame": None,
            "source": "kartaview",
            # KartaView photos carry real GPS metadata from the capture
            # device, so — unlike hand-typed/estimated coordinates — these
            # are trustworthy enough to mark verified automatically.
            "verified": True,
        }
        new_entries.append(entry)
        print(f"  + {loc_id}: {name} ({lat:.5f},{lng:.5f})\n    {img}")

    if args.dry_run:
        print(f"\nDry run: {len(new_entries)} candidates prepared, nothing written.")
        return

    pool.extend(new_entries)
    save_pool(pool)
    print(f"\nAdded {len(new_entries)} new locations. Pool size now {len(pool)}.")
    print("Run: python3 tools/build_pool.py  to re-encrypt.")


if __name__ == "__main__":
    main()
