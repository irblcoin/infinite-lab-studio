#!/usr/bin/env python3
"""Download the openly licensed sample packs that ship with ILS.

Sources
-------
* tidalcycles/Dirt-Samples (CC0 drum machine + percussion one-shots)
* nbrosowsky/tonejs-instruments (CC BY 3.0 recordings: guitars, bass, organ, harp)
* gleitz/midi-js-soundfonts FluidR3_GM (CC BY 3.0 GM recordings: toms, e-pianos,
  organs, sampled synth leads/pads, FX)

Everything is written into public/packs/<pack>/ and merged into
public/packs/index.json.  The script is resumable: files already on disk are
skipped, so a dropped connection only costs the current file.

    python3 scripts/fetch-packs.py [pack-id ...]
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKS_DIR = ROOT / "public" / "packs"
INDEX = PACKS_DIR / "index.json"

DIRT = "https://cdn.jsdelivr.net/gh/tidalcycles/Dirt-Samples@master"
TONEJS = "https://cdn.jsdelivr.net/gh/nbrosowsky/tonejs-instruments@master/samples"
FLUID = "https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM"

NOTE_RE = re.compile(r"^([A-G])([#bs]?)(-?\d)$")
NOTE_BASE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

lock = threading.Lock()
stats = {"files": 0, "bytes": 0, "failed": 0}


def note_to_midi(name: str) -> int | None:
    m = NOTE_RE.match(name.strip())
    if not m:
        return None
    letter, accidental, octave = m.groups()
    midi = (int(octave) + 1) * 12 + NOTE_BASE[letter]
    if accidental in ("#", "s"):
        midi += 1
    elif accidental == "b":
        midi -= 1
    return midi


def download(url: str, dest: Path, min_bytes: int = 800) -> bool:
    """Fetch one file, verifying it is really audio and not an HTML error page."""
    if dest.exists() and dest.stat().st_size >= min_bytes:
        with lock:
            stats["files"] += 1
            stats["bytes"] += dest.stat().st_size
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(3):
        code = os.system(
            f'curl -sSfL --max-time 60 --retry 1 -o "{tmp}" "{url}" 2>/dev/null'
        )
        if code == 0 and tmp.exists():
            head = tmp.read_bytes()[:16]
            ok = (
                head[:4] == b"RIFF"
                or head[:3] == b"ID3"
                or head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2")
                or head[:4] == b"OggS"
                or (len(head) > 4 and head[4:8] == b"ftyp")
            )
            if ok and tmp.stat().st_size >= min_bytes:
                tmp.replace(dest)
                with lock:
                    stats["files"] += 1
                    stats["bytes"] += dest.stat().st_size
                return True
        tmp.unlink(missing_ok=True)
    with lock:
        stats["failed"] += 1
    print(f"  !! failed {url}", flush=True)
    return False


def fine_name(name: str) -> str:
    # '#' in a URL becomes a fragment; use 's' for sharps (Fs3).
    return name.replace("#", "s")


def zones_from_notes(notes: list[int], step: int = 1) -> list[dict]:
    """Zones covering the full keyboard around the sampled notes."""
    picked = notes[::step] if step > 1 else notes
    zones = []
    for i, n in enumerate(picked):
        lo = 0 if i == 0 else (picked[i - 1] + n) // 2 + 1
        hi = 127 if i == len(picked) - 1 else (n + picked[i + 1]) // 2
        zones.append({"root": n, "lo": lo, "hi": hi, "velLo": 0, "velHi": 127})
    return zones


# ---------------------------------------------------------------------------
# FluidR3 (per-note mp3s)
# ---------------------------------------------------------------------------
def fluid_instrument(pack: str, folder: str, inst_id: str, name: str, category: str,
                     description: str, step: int = 1, gain: float = 0.9) -> dict | None:
    dest = PACKS_DIR / pack / folder
    dest.mkdir(parents=True, exist_ok=True)
    notes: list[tuple[int, str]] = []
    for midi in range(21, 109):
        octave = midi // 12 - 1
        name_note = ["C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B"][midi % 12]
        file = f"{name_note}{octave}.mp3"
        notes.append((midi, file))
    # only fetch the notes we will actually map
    keep = [n for i, n in enumerate(notes) if i % step == 0]
    files: list[dict] = []
    for midi, file in keep:
        url = f"{FLUID}/{folder}/{file}"
        if download(url, dest / file):
            files.append({"file": file, "midi": midi})
    if not files:
        return None
    z = zones_from_notes([f["midi"] for f in files])
    zones = []
    for zone, f in zip(z, files):
        # Zone paths are relative to the pack folder, so include the sub-folder.
        zones.append({"file": f"{folder}/{f['file']}", **zone})
    return {
        "id": inst_id,
        "name": name,
        "category": category,
        "packId": pack,
        "source": "pack",
        "gain": gain,
        "bundled": True,
        "description": description,
        "zones": zones,
    }


# ---------------------------------------------------------------------------
# tonejs-instruments (A2 / As2 / C3 naming)
# ---------------------------------------------------------------------------
def tonejs_notes(folder: str) -> list[tuple[int, str]]:
    """Note list for a tonejs-instruments folder, from the cached scrape."""
    cache = Path("/tmp/listings.json")
    if not cache.exists():
        return []
    data = json.loads(cache.read_text())
    for key, files in data.items():
        if key.endswith("samples/" + folder):
            out = []
            for f in files:
                if not f.lower().endswith(".mp3"):
                    continue
                midi = note_to_midi(f[:-4])
                if midi is not None:
                    out.append((midi, f))
            return sorted(out)
    return []


def tonejs_instrument(pack: str, folder: str, inst_id: str, name: str, category: str,
                      description: str, gain: float = 0.9) -> dict | None:
    dest = PACKS_DIR / pack / folder
    dest.mkdir(parents=True, exist_ok=True)
    # Prefer the scraped note list; fall back to probing every semitone.
    known = tonejs_notes(folder)
    entries: list[tuple[int, str]] = []
    if known:
        for midi, file in known:
            if download(f"{TONEJS}/{folder}/{file}", dest / file, min_bytes=3000):
                entries.append((midi, file))
        z = zones_from_notes([m for m, _ in entries]) if entries else []
        zones = [{"file": f"{folder}/{f}", **zone} for zone, (_, f) in zip(z, entries)]
        if zones:
            return {
                "id": inst_id, "name": name, "category": category, "packId": pack,
                "source": "pack", "gain": gain, "bundled": True,
                "description": description, "zones": zones,
            }
    for midi in range(21, 109):
        octave = midi // 12 - 1
        note = ["C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B"][midi % 12]
        file = f"{note}{octave}.mp3"
        url = f"{TONEJS}/{folder}/{file}"
        if download(url, dest / file, min_bytes=3000):
            entries.append((midi, file))
    if not entries:
        return None
    z = zones_from_notes([m for m, _ in entries])
    zones = [{"file": f"{folder}/{f}", **zone} for zone, (_, f) in zip(z, entries)]
    return {
        "id": inst_id,
        "name": name,
        "category": category,
        "packId": pack,
        "source": "pack",
        "gain": gain,
        "bundled": True,
        "description": description,
        "zones": zones,
    }


# ---------------------------------------------------------------------------
# Drum kits from Dirt-Samples
# ---------------------------------------------------------------------------
GM_PADS = {
    "kick": 36, "side": 37, "snare": 38, "clap": 39, "snare2": 40, "tomL": 41,
    "hat": 42, "tomLM": 43, "hatPedal": 44, "tomM": 45, "hatOpen": 46, "tomML": 47,
    "tomH": 48, "crash": 49, "tomH2": 50, "ride": 51, "rideBell": 53, "tamb": 54,
    "cowbell": 56, "crash2": 57, "ride2": 59, "bongoH": 60, "bongoL": 61,
    "congaH": 62, "congaM": 63, "congaL": 64, "timbaleH": 65, "timbaleL": 66,
    "agogoH": 67, "agogoL": 68, "cabasa": 69, "maracas": 70, "claves": 75,
    "woodH": 76, "woodL": 77, "perc": 75, "perc2": 76,
}


def dirt_pad(pack: str, note: int, files: list[str], folder: str = "") -> dict | None:
    """One pad: several real hits become velocity layers and round-robin slots."""
    dest = PACKS_DIR / pack / folder
    dest.mkdir(parents=True, exist_ok=True)
    got: list[str] = []
    for f in files:
        src = f"{DIRT}/{folder}/{f}" if folder else f"{DIRT}/{f}"
        name = fine_name(f.split("/")[-1])
        if download(src, dest / name, min_bytes=2000):
            # Zone paths are relative to the pack folder, so keep the sub-folder.
            got.append(f"{folder}/{name}" if folder else name)
    if not got:
        return None
    zones = []
    n = len(got)
    for i, f in enumerate(got):
        # Spread the real recordings across the velocity range and round-robin
        # within a layer, so soft hits and hard hits use different samples.
        layer = 0 if n == 1 else min(2, int(i * 3 / n))
        vel_lo, vel_hi = [(0, 42), (43, 84), (85, 127)][layer]
        zones.append({
            "file": f, "root": note, "lo": note, "hi": note,
            "velLo": vel_lo, "velHi": vel_hi,
        })
    return {"note": note, "zones": zones}


def file_list(folder: str, pattern: str | None = None) -> list[str]:
    """List a Dirt-Samples folder (cached scrape, then live scrape)."""
    cache = Path("/tmp/listings.json")
    files: list[str] = []
    if cache.exists():
        data = json.loads(cache.read_text())
        for key, entries in data.items():
            if key.endswith(":" + folder):
                files = entries
                break
    if not files:
        try:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            from ghls import listing  # type: ignore

            files = [
                i["name"]
                for i in listing("tidalcycles/Dirt-Samples", "main", folder)
                if i["type"] == "file"
            ]
        except Exception as err:
            print(f"  (could not list {folder}: {err})")
            return []
    out = [f for f in files if f.lower().endswith((".wav", ".aif", ".aiff"))]
    if pattern:
        out = [f for f in out if re.search(pattern, f, re.I)]
    return out


def main() -> None:
    wanted = set(sys.argv[1:])
    catalog = json.loads(INDEX.read_text())
    by_id = {p["id"]: p for p in catalog["packs"]}

    # ------------------------------------------------------------------ acoustic
    if not wanted or "acoustic" in wanted:
        print("== acoustic drum kit")
        kit: list[dict] = []
        plan = {
            "kick": ("bd", file_list("bd")[:8]),
            "snare": ("sn", file_list("sn")[:10]),
            "clap": ("realclaps", file_list("realclaps")[:4]),
            "hat": ("hh", [f for f in file_list("hh") if "closed" in f.lower() or "hh3" in f.lower()][:6]
                    or file_list("ho")[:6]),
            "hatOpen": ("ho", file_list("ho")[:5]),
            "ride": ("cr", file_list("cr")[:5]),
            "perc": ("perc", file_list("perc")[:6]),
        }
        for pad, (folder, files) in plan.items():
            if not files:
                continue
            p = dirt_pad("acoustic", GM_PADS[pad], files, folder)
            if p:
                kit.extend(p["zones"])
        # Toms: real recorded toms from the GM set, one note each.
        toms = fluid_instrument("acoustic", "melodic_tom-mp3", "tmp_tom", "Tom", "Drums", "x", step=96)
        if toms:
            for zone in toms["zones"][:1]:
                zone["lo"], zone["hi"], zone["root"] = 41, 41, 41
                kit.append(zone)
        if kit:
            by_id["acoustic"] = {
                "id": "acoustic",
                "name": "Acoustic Kit",
                "author": "Tidalcycles Dirt-Samples · Philharmonia toms",
                "license": "CC0 1.0",
                "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
                "source": "https://github.com/tidalcycles/Dirt-Samples",
                "description": "Recorded acoustic kick, snare, clap, hats, ride and percussion with layered velocities and round-robin hits.",
                "category": "Drums",
                "core": True,
                "instruments": [{
                    "id": "dr_acoustic",
                    "name": "Studio Acoustic",
                    "category": "Drums",
                    "packId": "acoustic",
                    "source": "pack",
                    "gain": 0.95,
                    "bundled": True,
                    "description": "Acoustic kit · layered + round-robin",
                    "zones": kit,
                }],
            }

    # -------------------------------------------------------------------- hiphop
    if not wanted or "hiphop" in wanted:
        print("== hip hop / trap / r&b / edm kits + 808")
        kits: list[dict] = []
        def build(kit_id: str, kit_name: str, desc: str, mapping: dict[str, tuple[str, list[str]]]) -> None:
            zones: list[dict] = []
            for pad, (folder, files) in mapping.items():
                if not files:
                    continue
                p = dirt_pad("hiphop", GM_PADS[pad], files, folder)
                if p:
                    zones.extend(p["zones"])
            if zones:
                kits.append({
                    "id": kit_id, "name": kit_name, "category": "Drums",
                    "packId": "hiphop", "source": "pack", "gain": 0.95, "bundled": True,
                    "description": desc, "zones": zones,
                })

        bd = file_list("bd")
        sd = file_list("sn")
        hh = file_list("hh")
        ho = file_list("ho")
        perc = file_list("perc") + file_list("realclaps")
        build("kit_boombap", "Boom Bap Kit", "Dusty sampled kick, snare, hats and percussion",
              {"kick": ("bd", bd[:6]), "snare": ("sn", sd[:8]), "hat": ("hh", hh[:5]),
               "hatOpen": ("ho", ho[:3]), "perc": ("perc", perc[:4])})
        build("kit_trap", "Trap Kit", "808 kick, tight snare, rolling hats",
              {"kick": ("808bd", file_list("808bd")[:8]), "snare": ("808sd", file_list("808sd")[:8]),
               "hat": ("808oh", file_list("808oh")[:3]), "clap": ("realclaps", file_list("realclaps")[:3])})
        build("kit_rnb", "R&B Kit", "Soft kick, layered snare, smooth percussion",
              {"kick": ("bd", [f for f in bd if "BT0" in f][:4] or bd[:4]),
               "snare": ("sn", sd[:6]), "clap": ("realclaps", file_list("realclaps")[:4]),
               "hat": ("hh", hh[:4]), "hatOpen": ("ho", ho[:3])})
        build("kit_edm", "EDM Kit", "Club kick, big clap, open hats",
              {"kick": ("808bd", file_list("808bd")[-6:]), "clap": ("realclaps", file_list("realclaps")[:4]),
               "hatOpen": ("808oh", file_list("808oh")[:4]), "hat": ("hh", hh[:4])})

        # Tuned 808 bass: one real 808 kick mapped across four octaves so it can
        # be played chromatically (the classic sub-bass trick).
        long808 = file_list("808bd")
        pick = [f for f in long808 if "BD0" in f.upper()][:1] or long808[:1]
        if pick:
            dest = PACKS_DIR / "hiphop" / "808"
            dest.mkdir(parents=True, exist_ok=True)
            if download(f"{DIRT}/808bd/{pick[0]}", dest / "808.wav", 2000):
                zones = [{"file": "808/808.wav", "root": 36, "lo": 0, "hi": 47,
                          "velLo": 0, "velHi": 127},
                         {"file": "808/808.wav", "root": 36, "lo": 48, "hi": 127,
                          "velLo": 0, "velHi": 127, "tune": 0}]
                kits.append({
                    "id": "bass_808", "name": "808 Sub Bass", "category": "Bass",
                    "packId": "hiphop", "source": "pack", "gain": 0.95, "bundled": True,
                    "description": "Tuned TR-808 kick played chromatically as sub bass",
                    "zones": zones,
                })
        if kits:
            by_id["hiphop"] = {
                "id": "hiphop", "name": "Hip Hop & Club Kits",
                "author": "Tidalcycles Dirt-Samples contributors",
                "license": "CC0 1.0",
                "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
                "source": "https://github.com/tidalcycles/Dirt-Samples",
                "description": "Boom bap, trap, R&B and EDM kits plus a playable 808 sub bass, all from real drum machine and drum recordings.",
                "category": "Drums", "core": True, "instruments": kits,
            }

    # ------------------------------------------------------------------- guitars
    if not wanted or "guitars" in wanted:
        print("== guitars + electric bass")
        insts = []
        for folder, iid, name, cat, desc in [
            ("guitar-acoustic", "gt_acoustic", "Acoustic Guitar", "Guitar", "Steel-string acoustic, multisampled"),
            ("guitar-nylon", "gt_nylon", "Nylon Guitar", "Guitar", "Classical nylon-string guitar"),
            ("guitar-electric", "gt_electric", "Electric Guitar", "Guitar", "Clean electric guitar, multisampled"),
            ("bass-electric", "bass_electric", "Electric Bass", "Bass", "Fingered electric bass, multisampled"),
        ]:
            p = tonejs_instrument("guitars", folder, iid, name, cat, desc, gain=0.95)
            if p:
                insts.append(p)
        if insts:
            by_id["guitars"] = {
                "id": "guitars", "name": "Guitars & Bass",
                "author": "nbrosowsky / tonejs-instruments (Philharmonia samples)",
                "license": "CC BY 3.0",
                "licenseUrl": "https://creativecommons.org/licenses/by/3.0/",
                "source": "https://github.com/nbrosowsky/tonejs-instruments",
                "description": "Real acoustic, nylon and electric guitars plus a fingered electric bass, sampled note by note.",
                "category": "Guitar", "instruments": insts,
            }

    # --------------------------------------------------------------------- keys
    if not wanted or "keys2" in wanted:
        print("== upright piano, organ, harp, celesta")
        insts = []
        uph = fluid_instrument("keys2", "honkytonk_piano-mp3", "key_upright", "Upright Piano",
                               "Piano", "Honky-tonk upright piano", step=3, gain=0.95)
        if uph:
            insts.append(uph)
        cel = fluid_instrument("keys2", "celesta-mp3", "key_celesta", "Celesta", "Mallets",
                               "Celesta / bell keyboard", step=3, gain=0.95)
        if cel:
            insts.append(cel)
        for folder, iid, name, cat, desc in [
            ("organ", "key_organ", "Drawbar Organ", "Organ", "Tonewheel organ, multisampled"),
            ("harmonium", "key_harmonium", "Harmonium", "Organ", "Reed harmonium, multisampled"),
        ]:
            p = tonejs_instrument("keys2", folder, iid, name, cat, desc, gain=0.95)
            if p:
                insts.append(p)
        if insts:
            by_id["keys2"] = {
                "id": "keys2", "name": "Pianos & Keys",
                "author": "FluidR3 (Frank Wen) · nbrosowsky tonejs-instruments",
                "license": "CC BY 3.0",
                "licenseUrl": "https://creativecommons.org/licenses/by/3.0/",
                "source": "https://github.com/gleitz/midi-js-soundfonts",
                "description": "Upright piano, celesta, drawbar organ, harmonium and concert harp recorded note by note.",
                "category": "Keys", "instruments": insts,
            }

    # ------------------------------------------------------------------- synths
    if not wanted or "synths" in wanted:
        print("== sampled synth leads + pads")
        insts = []
        for folder, iid, name, cat in [
            ("lead_1_square-mp3", "syn_lead_square", "Square Lead", "Synth"),
            ("lead_2_sawtooth-mp3", "syn_lead_saw", "Saw Lead", "Synth"),
            ("lead_6_voice-mp3", "syn_lead_voice", "Voice Lead", "Synth"),
            ("lead_7_fifths-mp3", "syn_lead_fifths", "Fifths Lead", "Synth"),
            ("pad_1_new_age-mp3", "syn_pad_newage", "New Age Pad", "Synth"),
            ("pad_2_warm-mp3", "syn_pad_warm", "Warm Pad", "Synth"),
            ("pad_3_polysynth-mp3", "syn_pad_poly", "Polysynth Pad", "Synth"),
            ("pad_4_choir-mp3", "syn_pad_choir", "Choir Pad", "Synth"),
            ("pad_7_halo-mp3", "syn_pad_halo", "Halo Pad", "Synth"),
            ("pad_8_sweep-mp3", "syn_pad_sweep", "Sweep Pad", "Synth"),
            ("synth_choir-mp3", "syn_choir", "Synth Choir", "Choir"),
            ("synth_brass_1-mp3", "syn_brass", "Synth Brass", "Brass"),
        ]:
            p = fluid_instrument("synths", folder, iid, name, cat, "Sampled analogue-style " + name.lower(),
                                 step=6, gain=0.9)
            if p:
                insts.append(p)
        if insts:
            by_id["synths"] = {
                "id": "synths", "name": "Sampled Synths",
                "author": "FluidR3 (Frank Wen)",
                "license": "CC BY 3.0",
                "licenseUrl": "https://creativecommons.org/licenses/by/3.0/",
                "source": "https://github.com/gleitz/midi-js-soundfonts",
                "description": "Classic synth leads, pads and brass sampled from the FluidR3 set — real recordings, not code-generated oscillators.",
                "category": "Synth", "instruments": insts,
            }

    # ----------------------------------------------------------------------- fx
    if not wanted or "fx" in wanted:
        print("== FX: risers, impacts, sweeps, vinyl")
        insts = []
        for folder, iid, name, cat, desc, step in [
            ("reverse_cymbal-mp3", "fx_riser", "Riser", "FX", "Reverse cymbal riser built from a real cymbal", 96),
            ("orchestra_hit-mp3", "fx_impact", "Impact", "FX", "Orchestral impact hit", 96),
            ("fx_4_atmosphere-mp3", "fx_sweep", "Sweep", "FX", "Atmosphere sweep", 48),
            ("fx_8_scifi-mp3", "fx_scifi", "Sci-Fi FX", "FX", "Sci-fi texture", 48),
            ("applause-mp3", "fx_crowd", "Crowd", "FX", "Applause recording", 96),
            ("seashore-mp3", "fx_room", "Room Tone", "FX", "Seashore / room noise bed", 96),
        ]:
            p = fluid_instrument("fx", folder, iid, name, cat, desc, step=step, gain=1.0)
            if p:
                insts.append(p)
        dest = PACKS_DIR / "fx" / "noise"
        dest.mkdir(parents=True, exist_ok=True)
        if download(f"{DIRT}/noise/000_noise.wav", dest / "vinyl_noise.wav", 2000):
            insts.append({
                "id": "fx_vinyl", "name": "Vinyl Noise", "category": "FX",
                "packId": "fx", "source": "pack", "gain": 1.0, "bundled": True,
                "description": "Real vinyl / surface noise loop",
                "zones": [{"file": "noise/vinyl_noise.wav", "root": 60, "lo": 0, "hi": 127,
                           "velLo": 0, "velHi": 127, "loopStart": 0.05, "loopEnd": 1.4}],
            })
        if insts:
            by_id["fx"] = {
                "id": "fx", "name": "FX & Textures",
                "author": "FluidR3 (Frank Wen) · Dirt-Samples",
                "license": "CC BY 3.0 / CC0",
                "licenseUrl": "https://creativecommons.org/licenses/by/3.0/",
                "source": "https://github.com/gleitz/midi-js-soundfonts",
                "description": "Risers, impacts, sweeps, sci-fi textures, crowd and vinyl noise.",
                "category": "FX", "instruments": insts,
            }

    # ------------------------------------------------------------------ finalise
    packs = list(by_id.values())
    for pack in packs:
        folder = PACKS_DIR / pack["id"]
        files = []
        total = 0
        for path in sorted(folder.rglob("*")):
            if path.is_file():
                rel = path.relative_to(folder).as_posix()
                files.append({"path": rel, "bytes": path.stat().st_size})
                total += path.stat().st_size
        pack["files"] = files
        pack["bytes"] = total
        if "instruments" not in pack:
            pack["instruments"] = []

    catalog["packs"] = packs
    catalog["generated"] = "2026-11-18"
    INDEX.write_text(json.dumps(catalog, indent=1))
    print(f"\ndownloaded {stats['files']} files, {stats['bytes']/1e6:.1f} MB, {stats['failed']} failures")
    for pack in packs:
        print(f"  {pack['id']:10} {len(pack['files']):5} files {pack['bytes']/1e6:7.1f} MB  {len(pack['instruments'])} instruments")


if __name__ == "__main__":
    main()
