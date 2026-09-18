"""Shared AES-256-GCM encrypt/decrypt helpers for SundGuesser.

The wire format is a small JSON envelope so it can be decrypted symmetrically
in the browser using the Web Crypto SubtleCrypto API:

    {"iv": "<base64 12-byte nonce>", "data": "<base64 ciphertext+tag>"}

The key is a 256-bit AES key, base64-encoded, and must be identical between
local tooling (secrets/key.txt) and the GitHub Actions secret used by CI
(currently mapped from the repo secret SUPERSECRETKEY into the LOCATIONS_KEY
env var inside the workflow files) used both to run the daily game-generation
workflow and to inject the key into the deployed static site.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

REPO_ROOT = Path(__file__).resolve().parent.parent
SECRETS_DIR = REPO_ROOT / "secrets"
KEY_FILE = SECRETS_DIR / "key.txt"


def generate_key_b64() -> str:
    return base64.b64encode(AESGCM.generate_key(bit_length=256)).decode("ascii")


def load_key_b64() -> str:
    """Load the AES key, preferring the LOCATIONS_KEY env var (used in CI),
    falling back to the local gitignored secrets/key.txt (used by developers).
    """
    env_key = os.environ.get("LOCATIONS_KEY")
    if env_key:
        return env_key.strip()
    if KEY_FILE.exists():
        return KEY_FILE.read_text().strip()
    raise RuntimeError(
        "No encryption key found. Set LOCATIONS_KEY env var or create "
        f"{KEY_FILE} (run tools/init_key.py to generate one)."
    )


def encrypt_json(obj, key_b64: str) -> dict:
    key = base64.b64decode(key_b64)
    aesgcm = AESGCM(key)
    iv = os.urandom(12)
    plaintext = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    ciphertext = aesgcm.encrypt(iv, plaintext, None)
    return {
        "iv": base64.b64encode(iv).decode("ascii"),
        "data": base64.b64encode(ciphertext).decode("ascii"),
    }


def decrypt_json(envelope: dict, key_b64: str):
    key = base64.b64decode(key_b64)
    aesgcm = AESGCM(key)
    iv = base64.b64decode(envelope["iv"])
    ciphertext = base64.b64decode(envelope["data"])
    plaintext = aesgcm.decrypt(iv, ciphertext, None)
    return json.loads(plaintext.decode("utf-8"))
