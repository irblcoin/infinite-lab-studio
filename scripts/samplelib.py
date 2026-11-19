"""Helpers shared by the sample fetchers (GitHub listings, pitch names, zones).

GitHub's API is rate limited from cloud IPs, so listings are scraped from the
tree page's embedded JSON instead.
"""
import json
import re
import subprocess
import urllib.parse

PITCH = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}
# Matches the last pitch token in names like `chorus-female-a#4.wav` and
# `susvib_C1_v1_1.wav` (letter, optional sharp, octave).
NOTE_RE = re.compile(r"[_-]([a-g])([#s])?(-?\d{1,2})(?=[._-]|$)", re.I)


def fetch(url: str, timeout: int = 60) -> bytes:
    return subprocess.run(
        ["curl", "-sL", "--max-time", str(timeout), "-A", "Mozilla/5.0", url],
        capture_output=True,
    ).stdout


def is_sample(data: bytes) -> bool:
    """True for real audio bytes; false for 404 bodies and HTML error pages."""
    return len(data) > 2048 and data[:4] not in (b"404:", b"<!DO")


def listing(repo: str, branch: str, folder: str) -> list[str]:
    url = f"https://github.com/{repo}/tree/{branch}/" + urllib.parse.quote(folder)
    html = fetch(url).decode("utf-8", "replace")
    m = re.search(r'"items":\[', html)
    if not m:
        return []
    start = m.end() - 1
    depth = 0
    for i in range(start, min(len(html), start + 2_000_000)):
        c = html[i]
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                try:
                    items = json.loads(html[start : i + 1])
                except Exception:
                    return []
                return [it["name"] for it in items if it.get("contentType") == "file"]
    return []


def safe_name(name: str) -> str:
    """`#` in a file name breaks static hosting (the server reads it as a fragment)."""
    return name.replace("#", "s")


def note_of(name: str) -> int | None:
    stem = re.sub(r"\.[a-z0-9]+$", "", name, flags=re.I)
    hits = NOTE_RE.findall(stem)
    if not hits:
        return None
    letter, accidental, octave = hits[-1]
    midi = (int(octave) + 1) * 12 + PITCH[letter.lower()] + (1 if accidental else 0)
    return midi if 12 <= midi <= 120 else None


def zones_for(entries: list[tuple[int, str]]) -> list[dict]:
    """Turn (root, file) pairs into zones, splitting the key range between roots."""
    roots = sorted({r for r, _ in entries})
    if not roots:
        return []
    span = {}
    for i, r in enumerate(roots):
        lo = 0 if i == 0 else (roots[i - 1] + r) // 2 + 1
        hi = 127 if i == len(roots) - 1 else (r + roots[i + 1]) // 2
        span[r] = (lo, hi)
    counts: dict[int, int] = {}
    out = []
    for root, file in sorted(entries, key=lambda e: (e[0], e[1])):
        lo, hi = span[root]
        seq = counts.get(root, 0)
        counts[root] = seq + 1
        zone = {"file": file, "root": root, "lo": lo, "hi": hi, "velLo": 0, "velHi": 127}
        if seq:
            zone["seq"] = seq
        out.append(zone)
    return out
