#!/usr/bin/env python3
"""List a GitHub repo directory by scraping the tree page's embedded JSON.

Used by scripts/fetch-packs.py to discover sample files without the GitHub API
(which is rate limited from CI/cloud IPs).  Usage:
    python3 scripts/ghls.py <owner/repo> <branch> [path]
"""
import json, re, subprocess, sys, urllib.parse


def fetch(url: str) -> str:
    out = subprocess.run(
        ["curl", "-sL", "--max-time", "40", "-A", "Mozilla/5.0", url],
        capture_output=True,
        text=True,
    )
    return out.stdout


def listing(repo: str, branch: str, path: str = ""):
    url = f"https://github.com/{repo}/tree/{branch}/{urllib.parse.quote(path)}".rstrip("/")
    html = fetch(url)
    items = None
    for m in re.finditer(r'"items":\[', html):
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
                        pass
                    break
        if items:
            break
    if not items:
        links = re.findall(
            r'href="/%s/(?:blob|tree)/%s/([^"]+)"' % (re.escape(repo), re.escape(branch)), html
        )
        return [
            {"name": l.split("/")[-1], "path": l, "type": "?"}
            for l in dict.fromkeys(links)
        ]
    res = []
    for it in items:
        if not isinstance(it, dict):
            continue
        ct = it.get("contentType") or ("directory" if it.get("type") == "tree" else "file")
        res.append(
            {
                "name": it.get("name") or "",
                "path": it.get("path") or "",
                "type": "dir" if ct == "directory" else "file",
            }
        )
    return res


if __name__ == "__main__":
    repo, branch = sys.argv[1], sys.argv[2]
    path = sys.argv[3] if len(sys.argv) > 3 else ""
    for it in listing(repo, branch, path):
        print(f"{it['type']:4} {it['name']}")
