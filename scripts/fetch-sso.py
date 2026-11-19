#!/usr/bin/env python3
"""Fetch the Sonatina Symphonic Orchestra pack from GitHub.

Samples live in peastman/sso under `Sonatina Symphonic Orchestra/Samples/`.
Only the sections whose files download cleanly are kept: Sonatina's violin and
cello FLACs in that repository are 1.4 KB near-empty files, so strings come
from the VSCO pack instead. WAVs are stored as-is here and encoded by
`node scripts/encode-pack-mp3.mjs sso`.

Usage:  python3 scripts/fetch-sso.py              # all instruments
        python3 scripts/fetch-sso.py sso_harp     # one instrument
"""
import json
import re
import sys
import urllib.parse
from pathlib import Path

from samplelib import fetch, is_sample, listing, note_of, safe_name, zones_for

ROOT = Path(__file__).resolve().parent.parent
PACKS_DIR = ROOT / "public" / "packs"
INDEX = PACKS_DIR / "index.json"
REPO = "peastman/sso"
BRANCH = "master"
SAMPLES = "Sonatina Symphonic Orchestra/Samples"
RAW = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/"

# id, folder, display name, category, file-name filter, gain
INSTRUMENTS = [
    ("sso_chorus_female", "Chorus", "Choir – Female", "Orchestral", "chorus-female", 0.9),
    ("sso_chorus_male", "Chorus", "Choir – Male", "Orchestral", "chorus-male", 0.9),
    ("sso_flutes", "Flutes", "Flutes (staccato)", "Orchestral", "-stc-", 1.0),
    ("sso_clarinets", "Clarinets", "Clarinets (sustain)", "Orchestral", "-sus-", 1.0),
    ("sso_harp", "Harp", "Concert Harp", "Keys", "", 1.0),
]


def build_one(inst_id: str, folder: str, name: str, category: str, filt: str, gain: float):
    """Download one instrument. Returns (patch, files) or None with a reason."""
    names = [f for f in listing(REPO, BRANCH, f"{SAMPLES}/{folder}") if filt.lower() in f.lower()]
    if not names:
        return None, "folder listing empty"
    dest = PACKS_DIR / "sso" / folder
    dest.mkdir(parents=True, exist_ok=True)
    entries: list[tuple[int, str]] = []
    files: list[dict] = []
    skipped: list[str] = []
    for file_name in names:
        root = note_of(file_name)
        if root is None:
            continue
        data = fetch(RAW + urllib.parse.quote(f"{SAMPLES}/{folder}/{file_name}"))
        if not is_sample(data):
            skipped.append(file_name)
            continue
        # The catalogue points at the MP3 the encoder will produce.
        stored = safe_name(file_name)
        out_name = re.sub(r"\.wav$", ".mp3", safe_name(file_name), flags=re.I)
        (dest / stored).write_bytes(data)
        entries.append((root, f"{folder}/{out_name}"))
        files.append({"path": f"{folder}/{out_name}", "bytes": len(data)})
    if skipped:
        print(f"   {inst_id}: {len(skipped)} file(s) unavailable upstream: {', '.join(skipped[:4])}")
    if len({r for r, _ in entries}) < 3:
        return None, f"only {len(entries)} usable sample(s)"
    return {
        "id": inst_id,
        "name": name,
        "category": category,
        "packId": "sso",
        "source": "pack",
        "gain": gain,
        "bundled": True,
        "description": f"Sonatina Symphonic Orchestra – {name}",
        "zones": zones_for(entries),
    }, files


def main() -> None:
    wanted = sys.argv[1:]
    index = json.loads(INDEX.read_text())
    pack = next((p for p in index["packs"] if p["id"] == "sso"), None)
    instruments = list(pack["instruments"]) if pack else []
    files = list(pack["files"]) if pack else []

    for inst_id, folder, name, category, filt, gain in INSTRUMENTS:
        if wanted and inst_id not in wanted:
            continue
        patch, extra = build_one(inst_id, folder, name, category, filt, gain)
        if patch is None:
            print(f"!! {inst_id}: {extra} — keeping the previous entry")
            continue
        instruments = [i for i in instruments if i["id"] != inst_id]
        # replace only the files this instrument owns (other instruments may share a folder)
        owned = {f["path"] for f in extra}
        files = [f for f in files if f["path"] not in owned]
        files.extend(extra)
        instruments.append(patch)
        print(f"   {inst_id:20s} {len(patch['zones']):3d} zones")

    # Drop catalogue entries no zone references (e.g. leftovers from an earlier fetch).
    owned = {z["file"] for i in instruments for z in i["zones"]}
    files = [f for f in files if f["path"] in owned]

    meta = {
        "id": "sso",
        "name": "Sonatina Symphonic Orchestra",
        "author": "Mattias Westlund, Peter Eastman",
        "license": "CC Sampling Plus 1.0",
        "licenseUrl": "https://creativecommons.org/licenses/sampling+/1.0/",
        "source": "https://github.com/peastman/sso",
        "description": "Orchestral ensembles: choir, woodwinds and concert harp, sampled in minor thirds with round-robin layers.",
        "category": "Orchestral",
        "bytes": sum(f["bytes"] for f in files),
        "files": sorted(files, key=lambda f: f["path"]),
        "instruments": instruments,
    }
    index["packs"] = [p for p in index["packs"] if p["id"] != "sso"] + [meta]
    INDEX.write_text(json.dumps(index, indent=1))
    print(f"sso pack: {len(instruments)} instruments, {len(files)} files, {meta['bytes'] / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
