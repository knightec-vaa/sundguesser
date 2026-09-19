"""Shared helper for downloading and compressing a location's street-view
photo so it can be stored (base64-encoded) inside the encrypted location
pool, and later self-hosted from the repo instead of hotlinked from a
third-party image host.

Why: hotlinking KartaView (or any external) image URLs means the game
breaks if that host ever goes down/rate-limits/reorganizes its storage, and
adds extra round-trip latency for players. Since the pool is already
encrypted at rest (see crypto_lib.py), bundling the actual image bytes in
there costs nothing extra from a "don't leak unused answers" standpoint —
the ciphertext hides them exactly as it already hides lat/lng — while
letting the deployed site serve images from its own GitHub Pages origin.
"""
from __future__ import annotations

import base64
import io
import urllib.request

USER_AGENT = "SundGuesser/1.0 (lunch-time geoguesser prototype)"

MAX_DIMENSION = 1280  # matches the original KartaView "large thumb" size
JPEG_QUALITY = 72  # good balance of file size vs visible detail for this use case


def download_bytes(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def compress_image_bytes(raw: bytes) -> bytes:
    """Re-encode arbitrary image bytes as a size-capped, quality-capped JPEG."""
    from PIL import Image

    img = Image.open(io.BytesIO(raw))
    img = img.convert("RGB")
    img.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return out.getvalue()


def fetch_and_compress(url: str, raw: bytes | None = None) -> tuple[str, str]:
    """Downloads (unless `raw` bytes are already provided, avoiding a second
    fetch when the caller already downloaded the image for a quality check),
    compresses, and returns (base64_str, ext) ready to store as
    imgData/imgExt on a pool entry.
    """
    data = raw if raw is not None else download_bytes(url)
    compressed = compress_image_bytes(data)
    return base64.b64encode(compressed).decode("ascii"), "jpg"
