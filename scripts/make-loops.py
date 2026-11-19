#!/usr/bin/env python3
"""Render the 56 library loops from real recorded samples.

The old library loops were code-synthesised patterns.  These are rendered from
the licenced recordings that ship in public/packs (Dirt-Samples drum hits, JV
bass, pads, plucks) so the loop browser plays real audio, tagged with the tempo
and key it was made at.  The runtime time-stretches them to the project tempo.

    python3 scripts/make-loops.py            # writes /tmp/loops + src/data/loops.ts
    node scripts/encode-loops.mjs            # mp3 -> public/packs/loops
"""
from __future__ import annotations

import json
import math
import struct
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
PACKS = ROOT / "public" / "packs"
OUT = Path("/tmp/loops")
SR = 44100

NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


# ---------------------------------------------------------------------------
# audio helpers
# ---------------------------------------------------------------------------
def load_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as w:
        ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if sw == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif sw == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        v = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
        v = np.where(v & 0x800000, v - 0x1000000, v)
        data = v.astype(np.float32) / 8388608.0
    elif sw == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        data = np.frombuffer(raw, dtype=np.uint8).astype(np.float32) / 128.0 - 1.0
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    if sr != SR:
        idx = np.linspace(0, len(data) - 1, int(len(data) * SR / sr))
        data = np.interp(idx, np.arange(len(data)), data)
    return data.astype(np.float32), SR


def monaural(x: np.ndarray) -> np.ndarray:
    return x if x.ndim == 1 else x.mean(axis=1)


def f0(x: np.ndarray, sr: int = SR) -> float:
    """Crude but adequate fundamental estimate for short pitched samples."""
    x = monaural(x)
    if len(x) < 2000:
        return 0.0
    step = 2
    y = x[::step].astype(np.float64)
    sr2 = sr / step
    y = y - y.mean()
    # use the loudest window so silence does not swamp the autocorrelation
    win = min(len(y), int(sr2 * 0.12))
    start = int(np.argmax(np.convolve(np.abs(y), np.ones(win) / win, "same")) - win / 2)
    start = max(0, min(len(y) - win, start))
    seg = y[start : start + win]
    if len(seg) < 128 or np.abs(seg).max() < 1e-4:
        return 0.0
    ac = np.correlate(seg, seg, "full")[len(seg) - 1 :]
    lo, hi = int(sr2 / 500), min(len(ac) - 1, int(sr2 / 45))
    if hi <= lo:
        return 0.0
    peak = lo + int(np.argmax(ac[lo:hi]))
    if peak <= 0:
        return 0.0
    return sr2 / peak


def resample(x: np.ndarray, ratio: float) -> np.ndarray:
    if abs(ratio - 1) < 1e-4:
        return x
    n = max(2, int(len(x) / ratio))
    idx = np.linspace(0, len(x) - 1, n)
    return np.interp(idx, np.arange(len(x)), x).astype(np.float32)


def transpose_to(x: np.ndarray, target_hz: float) -> np.ndarray:
    found = f0(x)
    if found <= 0 or target_hz <= 0:
        return x
    semis = 12 * math.log2(target_hz / found)
    semis = max(-24, min(24, semis))
    return resample(x, 2 ** (semis / 12))


def fit(x: np.ndarray, dur: float, fade: float = 0.02) -> np.ndarray:
    n = max(8, int(dur * SR))
    if len(x) > n:
        x = x[:n].copy()
        f = max(4, int(fade * SR))
        if f < len(x):
            x[-f:] *= np.linspace(1, 0, f)
    else:
        x = np.pad(x, (0, n - len(x)))
    return x.astype(np.float32)


def place(mix: np.ndarray, sample: np.ndarray, at: float, gain: float, pan: float = 0.0) -> None:
    start = int(at * SR) % len(mix)
    n = min(len(sample), len(mix) - start)
    if n <= 0:
        return
    seg = sample[:n] * gain
    l = math.sqrt(max(0.02, (1 - pan) / 2))
    r = math.sqrt(max(0.02, (1 + pan) / 2))
    mix[start : start + n, 0] += seg * l
    mix[start : start + n, 1] += seg * r


def load_first(folder: str, pattern: str = "") -> np.ndarray | None:
    d = PACKS / folder
    if not d.exists():
        return None
    files = sorted(p for p in d.iterdir() if p.suffix.lower() in (".wav", ".aif"))
    if pattern:
        files = [p for p in files if pattern.lower() in p.name.lower()] or files
    for p in files:
        try:
            x, _ = load_wav(p)
            if len(x) > 400:
                return x
        except Exception:
            continue
    return None


def hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


# ---------------------------------------------------------------------------
# patterns
# ---------------------------------------------------------------------------
GENRES = [
    # id, label, bpm, root midi, scale intervals, swing
    ("hiphop", "Hip Hop", 90, 41, [0, 3, 5, 7, 10], 0.18),
    ("trap", "Trap", 140, 43, [0, 3, 5, 7, 10], 0.0),
    ("rnb", "R&B", 84, 38, [0, 3, 5, 7, 10], 0.12),
    ("pop", "Pop", 120, 48, [0, 2, 4, 5, 7, 9, 11], 0.0),
    ("dreampop", "Dream Pop", 96, 40, [0, 2, 4, 7, 9], 0.06),
    ("edm", "EDM", 126, 45, [0, 2, 3, 5, 7, 8, 10], 0.0),
    ("rock", "Rock", 112, 40, [0, 3, 5, 7, 10], 0.04),
    ("lofi", "Lo-Fi", 78, 46, [0, 2, 3, 5, 7, 8, 10], 0.22),
]

DRUMS = {
    "hiphop": dict(kick="x.....x..x......", snare="....x.......x...", hat="x.x.x.x.x.x.x.x.", perc="........x......."),
    "trap": dict(kick="x.....x...x.....", snare="........x.......", hat="xxxxxxxxxxxxxxxx", perc="....x.......x..."),
    "rnb": dict(kick="x......x..x.....", snare="....x.......x...", hat="x.x.x.x.x.x.x.x.", perc="..........x....."),
    "pop": dict(kick="x...x...x...x...", snare="....x.......x...", hat="x.x.x.x.x.x.x.x.", perc="......x........."),
    "dreampop": dict(kick="x.......x.......", snare="....x.......x...", hat="..x...x...x...x.", perc="............x..."),
    "edm": dict(kick="x...x...x...x...", snare="....x.......x...", hat="..x...x...x...x.", perc=".......x........"),
    "rock": dict(kick="x...x.....x.x...", snare="....x.......x...", hat="x.x.x.x.x.x.x.x.", perc="...........x...."),
    "lofi": dict(kick="x......x..x.....", snare="....x.......x...", hat="x..x..x.x..x..x.", perc="........x......."),
}

BASS = {
    "hiphop": [0, None, None, 0, None, 3, None, None, 5, None, None, None, 3, None, None, None],
    "trap": [0, None, 0, None, 0, None, 0, None, 5, None, 5, None, 3, None, 3, None],
    "rnb": [0, None, None, None, 7, None, None, None, 5, None, None, None, 3, None, None, None],
    "pop": [0, None, 0, None, 5, None, 5, None, 7, None, 7, None, 5, None, 5, None],
    "dreampop": [0, None, None, None, None, None, 5, None, 7, None, None, None, None, None, 5, None],
    "edm": [0, 0, None, 0, 0, None, 0, 0, 0, 0, None, 0, 0, None, 5, 5],
    "rock": [0, 0, None, 0, 0, None, 0, 0, 5, 5, None, 5, 3, 3, None, 3],
    "lofi": [0, None, None, 5, None, None, 3, None, 7, None, None, 5, None, None, 3, None],
}

CHORDS = {
    "hiphop": [(0, 3, 7, 10), (5, 8, 12, 15)],
    "trap": [(0, 3, 7), (5, 8, 12)],
    "rnb": [(0, 4, 7, 11), (5, 9, 12, 16)],
    "pop": [(0, 4, 7), (5, 9, 12), (7, 11, 14), (5, 9, 12)],
    "dreampop": [(0, 7, 12, 16), (5, 12, 16, 19)],
    "edm": [(0, 3, 7), (5, 8, 12), (8, 12, 15), (5, 8, 12)],
    "rock": [(0, 7, 12), (5, 12, 17), (3, 10, 15), (0, 7, 12)],
    "lofi": [(0, 3, 7, 10), (3, 7, 10, 14)],
}

MELODY = {
    "hiphop": [7, None, 10, None, 12, None, 10, None],
    "trap": [12, None, None, 15, None, 12, None, 10],
    "rnb": [7, 10, None, 12, None, 10, 7, None],
    "pop": [7, 9, 12, 9, 7, 4, 7, None],
    "dreampop": [12, None, 16, None, 19, None, 16, None],
    "edm": [12, 15, 12, 19, 12, 15, 12, 10],
    "rock": [7, 7, 10, 12, 7, 10, 12, 15],
    "lofi": [7, None, 10, 12, None, 10, 7, None],
}


def key_name(root: int, scale: list[int]) -> str:
    minorish = 3 in scale and 4 not in scale
    return f"{NOTE[root % 12]}{'min' if minorish else 'maj'}"


def render(genre_id: str, label: str, bpm: int, root: int, scale: list[int], swing: float,
           role: str, bars: int, samples: dict) -> tuple[np.ndarray, str]:
    spb = 60 / bpm
    total = bars * 4 * spb
    n = int(total * SR) + 1
    mix = np.zeros((n, 2), dtype=np.float32)
    step = spb / 4
    steps = bars * 16
    pattern = DRUMS[genre_id]

    def hit(name: str, pattern_str: str, gain: float, every: int = 1) -> None:
        sample = samples.get(name)
        if sample is None:
            return
        for i in range(0, steps, every):
            if pattern_str[i % len(pattern_str)] == "x":
                t = i * step + (swing * step if (i % 2) else 0)
                place(mix, fit(sample, min(1.2, step * 6)), t, gain)

    if role in ("drums", "full"):
        hit("kick", pattern["kick"], 0.95)
        hit("snare", pattern["snare"], 0.72)
        hit("hat", pattern["hat"], 0.3)
        hit("perc", pattern["perc"], 0.4)

    if role in ("bass", "full") and samples.get("bass") is not None:
        line = BASS[genre_id]
        for bar in range(bars // 1):
            for i, deg in enumerate(line):
                if deg is None:
                    continue
                note = transpose_to(samples["bass"], hz(root + scale[deg % len(scale)] + (deg // len(scale)) * 12))
                place(mix, fit(note, step * 2.4), (bar * 16 + i) * step, 0.55)

    if role in ("chords", "full") and samples.get("chord") is not None:
        prog = CHORDS[genre_id]
        for bar in range(bars):
            chord = prog[bar % len(prog)]
            for j, deg in enumerate(chord):
                note = transpose_to(samples["chord"], hz(root + 12 + scale[deg % len(scale)] + (deg // len(scale)) * 12))
                place(mix, fit(note, spb * 3.4), bar * 4 * spb + j * 0.004, 0.19)

    if role in ("melody", "arp", "full") and samples.get("pluck") is not None:
        line = MELODY[genre_id]
        for bar in range(bars):
            for i, deg in enumerate(line):
                if deg is None:
                    continue
                note = transpose_to(samples["pluck"], hz(root + 12 + scale[deg % len(scale)] + (deg // len(scale)) * 12))
                place(mix, fit(note, step * 3.2), (bar * 16 + i * 2) * step, 0.3)

    if role == "full" and samples.get("pad") is not None:
        for bar in range(bars):
            chord = CHORDS[genre_id][bar % len(CHORDS[genre_id])]
            for deg in chord[:3]:
                note = transpose_to(samples["pad"], hz(root + 24 + scale[deg % len(scale)]))
                place(mix, fit(note, spb * 4), bar * 4 * spb, 0.08)

    peak = np.abs(mix).max()
    if peak > 0:
        mix = mix / peak * 0.89
    if genre_id == "lofi":
        # real vinyl surface noise under the loop, at a low level
        vinyl = samples.get("vinyl")
        if vinyl is not None:
            bed = np.tile(vinyl, int(np.ceil(n / max(1, len(vinyl)))))[:n]
            mix[:, 0] += bed * 0.035
            mix[:, 1] += bed * 0.033
    return mix, key_name(root, scale)


def write_wav(path: Path, data: np.ndarray) -> None:
    pcm = np.clip(data, -1, 1)
    pcm = (pcm * 32000).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


SRC = Path("/tmp/loopsrc")


def fetch_wav(folder: str, count: int = 3) -> list[Path]:
    """Pull a few WAV one-shots from Dirt-Samples for the pitched loop parts."""
    import subprocess
    import sys

    sys.path.insert(0, str(ROOT / "scripts"))
    from ghls import listing  # type: ignore

    SRC.mkdir(parents=True, exist_ok=True)
    try:
        items = listing("tidalcycles/Dirt-Samples", "main", folder)
    except Exception:
        return []
    names = [i["name"] for i in items if i["type"] == "file" and i["name"].lower().endswith(".wav")]
    out: list[Path] = []
    for name in names[:count]:
        dest = SRC / f"{folder}_{name}"
        if not dest.exists():
            subprocess.run(
                ["curl", "-sSfL", "--max-time", "40", "-o", str(dest),
                 f"https://cdn.jsdelivr.net/gh/tidalcycles/Dirt-Samples@main/{folder}/{name}"],
                check=False,
            )
        if dest.exists() and dest.stat().st_size > 2000:
            out.append(dest)
    return out


def load_src(folder: str) -> np.ndarray | None:
    for p in fetch_wav(folder):
        try:
            x, _ = load_wav(p)
            if len(x) > 600 and np.abs(x).max() > 0.01:
                return x
        except Exception:
            continue
    return None


def pick(*arrs):
    for a in arrs:
        if a is not None:
            return a
    return None


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    samples = {
        "kick": pick(load_first("acoustic/bd"), load_first("hiphop/808bd")),
        "snare": pick(load_first("acoustic/sn"), load_first("hiphop/808sd")),
        "hat": pick(load_first("acoustic/hh"), load_first("acoustic/ho")),
        "perc": pick(load_first("acoustic/perc"), load_first("hiphop/realclaps")),
        "bass": pick(load_src("jvbass"), load_src("bass")),
        "chord": pick(load_src("pad"), load_src("stab")),
        "pluck": pick(load_src("pluck"), load_src("arp")),
        "pad": pick(load_src("padlong"), load_src("pad")),
        "vinyl": load_first("fx/noise"),
    }

    print("sample sources:", {k: (v is not None) for k, v in samples.items()})
    meta = []
    roles = [("drums", "Drums", 2), ("full", "Full Groove", 2), ("bass", "Bass", 2),
             ("chords", "Chords", 2), ("melody", "Melody", 2), ("arp", "Arp", 2), ("perc", "Percussion", 2)]
    for genre_id, label, bpm, root, scale, swing in GENRES:
        for role, role_label, bars in roles:
            mix, key = render(genre_id, label, bpm, root, scale, swing, role, bars, samples)
            lid = f"loop_{genre_id}_{role}"
            write_wav(OUT / f"{lid}.wav", mix)
            meta.append({
                "id": lid,
                "name": f"{label} {role_label}",
                "genre": genre_id,
                "genreLabel": label,
                "role": role,
                "bpm": bpm,
                "key": key,
                "bars": bars,
                "beats": bars * 4,
                "duration": round(len(mix) / SR, 3),
                "file": f"loops/{lid}.mp3",
            })
            print(f"  {lid:26} {bpm:3} BPM {key:4} {len(mix)/SR:5.2f}s")
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))
    print(f"\n{len(meta)} loops written to {OUT}")


if __name__ == "__main__":
    main()
