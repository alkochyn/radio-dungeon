"""Pull playable mp3 urls straight off a bandcamp page.

The desktop player resolves a stream through yt-dlp on every play, because bandcamp's
urls expire. The web build does it ahead of time instead: bandcamp hands out mp3-128
urls that stay valid for exactly 24 hours, so a scheduled rebuild keeps them fresh and
the listener's browser streams straight from bandcamp - no audio passes through us.

Every album page carries a `data-tralbum` blob: real JSON with one entry per track,
including its stream url. That means one request per album rather than one per track,
and no regex guessing against markup.
"""

import html as htmlmod
import json
import re
import time
from dataclasses import dataclass, field
from urllib.parse import urljoin

# Bandcamp stamps every stream url with the moment it stops working.
STREAM_TTL_SECONDS = 24 * 60 * 60

# Refreshing the whole catalogue means a few hundred requests in a row, and bandcamp
# answers 429 when it has had enough. Backing off and retrying is the difference between
# losing those albums from the site and just taking a little longer.
MAX_ATTEMPTS = 4
BACKOFF_BASE = 5  # seconds: 5, 10, 20 between attempts
MAX_BACKOFF = 120

_TRALBUM_RE = re.compile(r'data-tralbum="([^"]+)"')
_OG_IMAGE_RE = re.compile(r'<meta property="og:image" content="([^"]+)"')


class NotBandcamp(ValueError):
    """The page carries no tralbum data - not a bandcamp album/track page."""


@dataclass
class BcTrack:
    """One streamable track, as the web player needs it."""

    webpage_url: str  # the track's own page - doubles as the "buy on bandcamp" link
    title: str
    artist: str
    stream_url: str
    duration: float | None = None
    thumbnail: str | None = None
    album_url: str | None = None
    album_title: str = ""


@dataclass
class BcAlbum:
    url: str
    title: str = ""
    artist: str = ""
    thumbnail: str | None = None
    tracks: list[BcTrack] = field(default_factory=list)


def retry_delay(attempt: int, retry_after: str | None) -> float:
    """How long to wait before retrying - the server's own answer wins if it gave one."""
    if retry_after:
        try:
            return min(float(retry_after), MAX_BACKOFF)
        except ValueError:
            # Retry-After may be an HTTP date instead of seconds; fall through.
            pass
    return min(BACKOFF_BASE * (2**attempt), MAX_BACKOFF)


def fetch_page(client, url: str, log=print) -> str | None:
    """GET a bandcamp page, waiting out rate limits. None means give up on this page."""
    for attempt in range(MAX_ATTEMPTS):
        try:
            response = client.get(url)
        except Exception as exc:  # httpx errors, dns, timeouts
            wait = retry_delay(attempt, None)
            log(f"    сеть: {type(exc).__name__}, повтор через {wait:.0f}с")
            time.sleep(wait)
            continue

        if response.status_code == 200:
            return response.text
        # 429 is bandcamp asking us to slow down; 5xx is bandcamp having a bad moment.
        if response.status_code == 429 or response.status_code >= 500:
            wait = retry_delay(attempt, response.headers.get("Retry-After"))
            log(f"    HTTP {response.status_code}, повтор через {wait:.0f}с")
            time.sleep(wait)
            continue
        # 404 and friends will not get better by asking again.
        log(f"    HTTP {response.status_code}")
        return None

    log(f"    сдаюсь после {MAX_ATTEMPTS} попыток: {url}")
    return None


def stream_expiry(stream_url: str) -> int | None:
    """Unix time the url stops working, read from its own `ts` parameter."""
    m = re.search(r"[?&]ts=([0-9]+)", stream_url)
    return int(m.group(1)) if m else None


def parse_page(html: str, page_url: str) -> BcAlbum:
    """Read an album (or single-track) page into its streamable tracks."""
    m = _TRALBUM_RE.search(html)
    if not m:
        raise NotBandcamp(f"no data-tralbum on {page_url}")

    blob = json.loads(htmlmod.unescape(m.group(1)))
    current = blob.get("current") or {}

    art = _OG_IMAGE_RE.search(html)
    album = BcAlbum(
        url=blob.get("url") or page_url,
        title=current.get("title") or "",
        artist=blob.get("artist") or "",
        thumbnail=art.group(1) if art else None,
    )

    for entry in blob.get("trackinfo") or []:
        # `streaming` is 0 for preorder-only or artist-disabled tracks; those have no
        # playable file at all, so there is nothing to offer the browser.
        if not entry.get("streaming"):
            continue
        stream_url = (entry.get("file") or {}).get("mp3-128")
        if not stream_url:
            continue

        link = entry.get("title_link")
        album.tracks.append(
            BcTrack(
                webpage_url=urljoin(album.url, link) if link else album.url,
                title=entry.get("title") or "",
                # Compilations set a per-track artist; everything else inherits the album's.
                artist=entry.get("artist") or album.artist,
                stream_url=stream_url,
                duration=entry.get("duration"),
                thumbnail=album.thumbnail,
                album_url=album.url,
                album_title=album.title,
            )
        )

    return album


def album_url_from_track_page(html: str, page_url: str) -> str | None:
    """Find which album a track page belongs to.

    Only needed to backfill tracks discovered before album urls were recorded - once
    known, refreshes fetch the album directly and get every track in one request.
    """
    try:
        blob = json.loads(htmlmod.unescape(_TRALBUM_RE.search(html).group(1)))
    except (AttributeError, ValueError):
        return None

    for key in ("album_url", "url"):
        value = (blob.get("current") or {}).get(key) or blob.get(key)
        if value and "/album/" in value:
            return urljoin(page_url, value)

    m = re.search(r'<a[^>]+href="(/album/[^"]+)"', html)
    return urljoin(page_url, m.group(1)) if m else None
