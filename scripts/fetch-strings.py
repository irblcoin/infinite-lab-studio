#!/usr/bin/env python3
"""Add sustained string sections to the VSCO 2 CE pack.

Sonatina's violins and celli are unusable, and the original VSCO patches had
only five zones each, so this pulls the `susVib` sections from
sgossner/VSCO-2-CE (CC0): sustained samples with round-robin takes. WAVs are
stored here and encoded by `node scripts/encode-pack-mp3.mjs vsco2/strings`.

Usage:  python3 scripts/fetch-strings.py
"""
import json
import re
import urllib.parse
from pathlib import Path

from samplelib import fetch, is_sample, listing, note_of, safe_name, zones_for

ROOT = Path(__file__).resolve().parent.parent
PACKS_DIR = ROOT / "public" / "packs"
INDEX = PACKS_DIR / "index.json"
REPO = "sgossner/VSCO-2-CE"
BRANCH = "master"
RAW = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/"

# dest folder, source folder, file prefix, instrument id, display name
SECTIONS = [
    ("strings/violin", "Strings/Violin Section/susVib", "VlnEns_", "vsco_violin_ensemble", "VSCO Violin Ensemble"),
    ("strings/viola", "Strings/Viola Section/susvib", "", "vsco_viola_ensemble", "VSCO Viola Ensemble"),
    ("strings/cello", "Strings/Cello Section/susvib", "", "vsco_cello_ensemble", "VSCO Cello Ensemble"),
]


def build_section(dest_folder: str, src_folder: str, prefix: str):
    names = [f for f in listing(REPO, BRANCH, src_folder) if f.startswith(prefix)]
    if not names:
        return None, "folder listing empty"
    dest = PACKS_DIR / "vsco2" / dest_folder
    dest.mkdir(parents=True, exist_ok=True)
    entries: list[tuple[int, str]] = []
    files: list[dict] = []
    skipped: list[str] = []
    for file_name in names:
        root = note_of(file_name)
        if root is None:
            continue
        data = fetch(RAW + urllib.parse.quote(f"{src_folder}/{file_name}"))
        if not is_sample(data):
            skipped.append(file_name)
            continue
        stored = safe_name(file_name)
        out_name = re.sub(r"\.wav$", ".mp3", safe_name(file_name), flags=re.I)
        (dest / stored).write_bytes(data)
        entries.append((root, f"{dest_folder}/{out_name}"))
        files.append({"path": f"{dest_folder}/{out_name}", "bytes": len(data)})
    if skipped:
        print(f"   {dest_folder}: {len(skipped)} file(s) unavailable upstream: {', '.join(skipped[:4])}")
    if len({r for r, _ in entries}) < 3:
        return None, f"only {len(entries)} usable sample(s)"
    return entries, files


def main() -> None:
    index = json.loads(INDEX.read_text())
    pack = next(p for p in index["packs"] if p["id"] == "vsco2")
    built: list[tuple[str, str, str, list[tuple[int, str]]]] = []
    new_files: list[dict] = []

    for dest_folder, src_folder, prefix, inst_id, name in SECTIONS:
        entries, extra = build_section(dest_folder, src_folder, prefix)
        if entries is None:
            print(f"!! {inst_id}: {extra}")
            continue
        built.append((inst_id, name, dest_folder, entries))
        new_files.extend(extra)
        roots = sorted({r for r, _ in entries})
        print(f"   {dest_folder}: {len(entries)} files, {roots[0]}-{roots[-1]}")
    if not built:
        raise SystemExit("no string samples downloaded")

    # A single four-octave ensemble layering all three sections.
    combined = [e for *_, entries in built for e in entries]
    built.append(("vsco_string_ensemble", "String Ensemble (VSCO 2 CE)", "", combined))

    replaced = {inst_id for inst_id, *_ in built}
    pack["instruments"] = [i for i in pack["instruments"] if i["id"] not in replaced]
    for inst_id, name, _, entries in built:
        roots = sorted({r for r, _ in entries})
        pack["instruments"].append(
            {
                "id": inst_id,
                "name": name,
                "category": "Strings",
                "packId": "vsco2",
                "source": "pack",
                "gain": 0.95,
                "bundled": True,
                "description": f"VSCO 2 CE sustained section, {len(roots)} sampled keys across {roots[-1] - roots[0]} semitones",
                "zones": zones_for(entries),
            }
        )

    folders = {"/".join(f["path"].split("/")[:2]) for f in new_files}
    pack["files"] = [f for f in pack["files"] if "/".join(f["path"].split("/")[:2]) not in folders]
    pack["files"].extend(new_files)
    pack["files"].sort(key=lambda f: f["path"])
    pack["bytes"] = sum(f["bytes"] for f in pack["files"])
    pack["description"] = (
        "CC0 orchestral sections from Versilian Studios: sustained violin, viola and cello ensembles "
        "with round-robin layers, plus brass and woodwind soloists."
    )
    INDEX.write_text(json.dumps(index, indent=1))
    for inst_id, name, _, entries in built:
        roots = sorted({r for r, _ in entries})
        print(f"   {inst_id}: {len(roots)} roots, {roots[0]}-{roots[-1]} ({roots[-1] - roots[0]} semitones)")
    print(f"vsco2: {len(pack['instruments'])} instruments, {len(pack['files'])} files, {pack['bytes'] / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
