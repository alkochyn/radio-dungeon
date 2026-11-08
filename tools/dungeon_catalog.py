"""What dungeon-catalog knows about the channel's music, for the build.

dungeon-catalog (github.com/alkochyn/dungeon-catalog) is a separate service: it reads the
channel itself, and a browser extension on its owner's machine opens the bandcamp pages -
bandcamp has answered GitHub's runners with a bot check since 2026-11-06. From it the build
takes two things: fresh stream links, and each album as its page showed it (titles,
durations, cover). The sync builds new posts from the albums, the bake takes the links.

This is an extra source, not a replacement: the build still asks bandcamp itself and goes
on exactly as before if the catalog is unreachable or the variable is empty.
"""

import os
import re

import httpx

URL = os.environ.get("DUNGEON_CATALOG_URL", "https://80.47.239.2:8444/api/links")
USER_AGENT = "radio-dungeon-player build"

STREAM_RE = re.compile(r"^https://t\d+\.bcbits\.com/stream/\S+$")
PAGE_RE = re.compile(r"^https://[a-z0-9-]+\.bandcamp\.com/(album|track)/[^/]+$")
COVER_RE = re.compile(r"^https://f\d+\.bcbits\.com/img/[\w.-]+$")


def page_key(url) -> str:
    """One spelling for a bandcamp page: the channel and the extension may differ in case or slash."""
    m = re.match(r"^https?://([^/]+)(/[^?#]*)", url.strip()) if isinstance(url, str) else None
    key = f"https://{m.group(1).lower()}{m.group(2).rstrip('/')}" if m else ""
    return key if PAGE_RE.match(key) else ""


def fetch(url: str) -> dict:
    """Everything the server holds, as it came. Any trouble - nothing."""
    try:
        response = httpx.get(url, timeout=30, headers={"User-Agent": USER_AGENT})
        response.raise_for_status()
        payload = response.json()
    except Exception as failure:  # noqa: BLE001 - this source is a bonus, never a reason to fail
        print(f"из dungeon-catalog ничего не получено ({url}): {failure}")
        return {}
    return payload if isinstance(payload, dict) else {}


def clean_links(links) -> dict[str, str]:
    """Track page -> stream. Only bandcamp pages and bcbits streams: these end up in every listener's player."""
    clean = {}
    for page, stream in (links if isinstance(links, dict) else {}).items():
        key = page_key(page)
        if key and isinstance(stream, str) and STREAM_RE.match(stream):
            clean[key] = stream
    return clean


def _text(value) -> str:
    return value.strip()[:300] if isinstance(value, str) else ""


def clean_pages(pages) -> dict[str, dict]:
    """Page the extension opened -> the album it showed, same checks as the links."""
    clean = {}
    for page, album in (pages if isinstance(pages, dict) else {}).items():
        key = page_key(page)
        if not key or not isinstance(album, dict) or not isinstance(album.get("tracks"), list):
            continue
        album_url = page_key(album.get("album"))
        cover = album.get("cover") if isinstance(album.get("cover"), str) and COVER_RE.match(album["cover"]) else None
        tracks = []
        for t in album["tracks"]:
            url = page_key(t.get("url")) if isinstance(t, dict) else ""
            duration = t.get("duration") if url else None
            if not url or isinstance(duration, bool) or not isinstance(duration, (int, float)) or not 0 < duration < 36000:
                continue
            tracks.append({"url": url, "title": _text(t.get("title")), "artist": _text(t.get("artist")), "duration": duration})
        clean[key] = {
            "album_url": album_url or key,
            "album": _text(album.get("title")),
            "artist": _text(album.get("artist")),
            "thumbnail": cover,
            "tracks": tracks,
        }
    return clean


def track_details(pages: dict[str, dict]) -> dict[str, dict]:
    """Track page -> what the bake needs to know about it besides the link."""
    details = {}
    for album in pages.values():
        for t in album["tracks"]:
            details[t["url"]] = {
                "title": t["title"],
                "artist": t["artist"] or album["artist"],
                "thumbnail": album["thumbnail"],
                "webpage_url": t["url"],
                "album": album["album"],
                "album_url": album["album_url"],
                "duration": t["duration"],
            }
    return details
