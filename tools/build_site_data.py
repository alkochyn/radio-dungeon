"""Bake the static data file the web player loads.

The desktop player asks its own backend for a stream url every time you press play.
The web player has no backend: this script resolves every track ahead of time and
writes one json file that the browser reads directly. Bandcamp's urls last 24 hours,
so this is meant to run on a schedule (every few hours) and republish.

Requests are kept low by going album-first: every track in one Telegram post came from
the same album link, so one album page yields stream urls for all of them at once. The
album url per post is cached in albums.json, so only the first run pays for discovery.

Which posts a run touches is worked out up front rather than by walking the catalogue:
links that will not outlive the next run are refreshed no matter what, and a budget of
the next-soonest is refreshed early so that expiry times spread out instead of all
falling due in the same run. See the planning pass in main().

    python tools/build_site_data.py --limit 20     # quick prototype run
    python tools/build_site_data.py                # everything
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app import bandcamp  # noqa: E402

# Build inputs live outside site/ so that nothing but the player itself gets published.
CATALOG_DIR = ROOT / "catalog"
TRACKS_FILE = CATALOG_DIR / "tracks.json"
ALBUM_CACHE = CATALOG_DIR / "albums.json"
OUT_DIR = ROOT / "site" / "data"
OUT_FILE = OUT_DIR / "posts.json"

CHANNEL = "radio_dungeon"
# Bumped whenever a field is added to the baked records. Without it a run would happily
# reuse yesterday's entries forever and the new field would only appear on the albums
# that happened to need refreshing.
DATA_VERSION = 2
REQUEST_DELAY = float(os.environ.get("BC_REQUEST_DELAY", "1.0"))

# A link that will not survive until the next run has to be refreshed now, whatever it
# costs: a dead link is a track that will not play. 4h covers the 2h schedule with slack
# for a late or skipped run.
DUE_MARGIN = float(os.environ.get("BC_DUE_MARGIN_HOURS", "4")) * 3600
# On top of that, each run re-mints this many of the next-soonest albums early. Nothing
# needs them yet - the point is where their new expiry lands. See the planning pass in
# main() for why a run that has nothing due should still do work.
REFRESH_BUDGET = int(os.environ.get("BC_REFRESH_BUDGET", "120"))
TIMEOUT = 25
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36 radio-dungeon-player"
)


def load_json(path, default):
    if not path.exists():
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def group_posts(tracks: list[dict]) -> list[dict]:
    """Same grouping the desktop backend does, minus the personal data."""
    posts: dict[str, dict] = {}
    order: list[str] = []
    for t in tracks:
        mid = t.get("message_id")
        key = f"m:{mid}" if mid is not None else f"t:{t['id']}"
        if key not in posts:
            posts[key] = {
                "message_id": mid,
                "message_date": t.get("message_date"),
                "message_text": t.get("message_text", "") if mid is not None else "",
                "telegram_url": f"https://t.me/{CHANNEL}/{mid}" if mid is not None else None,
                "tracks": [],
            }
            order.append(key)
        posts[key]["tracks"].append(t)
    return [posts[k] for k in order]


def plan_refresh(soonest_of: dict[str, float], now: float) -> tuple[set[str], int]:
    """Pick the posts this run refreshes. Returns the set and how many were overdue.

    Bandcamp links live 24 hours and the whole catalogue was minted in one sitting, so
    left to itself it comes due all at once: three runs that do nothing followed by one
    that makes a thousand requests and takes half an hour. Two rules split that up.

      due    the link will not last until the next run. Always refreshed, never capped -
             a dead link is a track that will not play.
      ahead  a budget of the next-soonest, re-minted early on purpose. Nothing needs
             them yet; the point is where their new expiry lands. This is what breaks
             the herd apart - a run with nothing due spends itself spreading expiry
             times out rather than waiting for them all to fall due together.

    Steady state is the catalogue divided by the runs inside one link lifetime, which
    for ~1000 albums on a 2h schedule is ~85 albums a run, a minute or two of requests.
    """
    by_urgency = sorted(soonest_of, key=lambda k: soonest_of[k])
    deadline = now + DUE_MARGIN
    refresh = {k for k in by_urgency if soonest_of[k] <= deadline}
    due_count = len(refresh)
    for key in by_urgency:
        if len(refresh) >= REFRESH_BUDGET:
            break
        refresh.add(key)
    return refresh, due_count


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--limit",
        type=int,
        default=0,
        help="обработать только N самых свежих постов (для быстрой пробы)",
    )
    ap.add_argument(
        "--tracks",
        type=Path,
        default=TRACKS_FILE,
        help="откуда брать метаданные канала (по умолчанию catalog/tracks.json)",
    )
    args = ap.parse_args()

    tracks = load_json(args.tracks, [])
    if isinstance(tracks, dict):
        tracks = list(tracks.values())
    if not tracks:
        print(f"нет треков в {args.tracks} - сначала синхронизируй канал")
        return 1

    posts = group_posts(tracks)
    if args.limit:
        # Newest first: a short run is for eyeballing the result, and the oldest posts
        # in this channel are mostly youtube, which the static build cannot bake anyway.
        posts = sorted(posts, key=lambda p: p["message_id"] or 0, reverse=True)[: args.limit]
    print(f"постов: {len(posts)}, треков: {sum(len(p['tracks']) for p in posts)}")

    album_cache: dict[str, str] = load_json(ALBUM_CACHE, {})

    # Whatever the previous run baked is still good until its links approach expiry.
    previous = load_json(OUT_FILE, {})
    if previous.get("version") != DATA_VERSION:
        previous = {}
        print("формат данных изменился - запекаю заново, без переиспользования")
    previous_tracks: dict[str, dict] = {}
    for post in previous.get("posts", []):
        for t in post.get("tracks", []):
            if bandcamp.stream_expiry(t.get("stream_url", "")):
                previous_tracks[t["id"]] = t

    # What this run touches is decided before a single request goes out.
    now = time.time()
    soonest_of: dict[str, float] = {}
    for post in posts:
        bandcamp_tracks = [t for t in post["tracks"] if "bandcamp.com" in t["webpage_url"]]
        if not bandcamp_tracks:
            continue
        soonest = None
        for t in bandcamp_tracks:
            record = previous_tracks.get(t["id"])
            expiry = bandcamp.stream_expiry(record["stream_url"]) if record else None
            if expiry is None:
                # Never baked, or baked before there was a timestamp to read: fetch it.
                soonest = 0.0
                break
            if soonest is None or expiry < soonest:
                soonest = expiry
        soonest_of[str(post["message_id"])] = soonest if soonest is not None else 0.0

    refresh, due_count = plan_refresh(soonest_of, now)
    deadline = now + DUE_MARGIN
    print(
        f"обновляю: {due_count} протухающих + {len(refresh) - due_count} заранее, "
        f"переиспользую {len(soonest_of) - len(refresh)}"
    )

    out_posts = []
    stats = {
        "resolved": 0,
        "skipped": 0,
        "posts_failed": 0,
        "cache_hits": 0,
        "reused": 0,
        "ahead": 0,
    }
    soonest_expiry = None

    headers = {"User-Agent": USER_AGENT, "Accept-Language": "en,ru;q=0.9"}
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True, headers=headers) as client:
        for i, post in enumerate(posts, 1):
            label = f"[{i}/{len(posts)}] пост {post['message_id']}"
            originals = post["tracks"]
            bandcamp_tracks = [t for t in originals if "bandcamp.com" in t["webpage_url"]]
            if not bandcamp_tracks:
                # youtube and friends have short-lived, ip-bound urls - they can't be
                # baked, so they simply don't make it into the static build for now.
                stats["skipped"] += len(originals)
                print(f"{label}: нет bandcamp-треков, пропуск")
                continue

            key = str(post["message_id"])
            # Not picked by the planning pass: every link here is known good and has
            # time left, so there is nothing to ask bandcamp about.
            if key not in refresh:
                reusable = [previous_tracks[t["id"]] for t in bandcamp_tracks]
                for t in reusable:
                    expiry = bandcamp.stream_expiry(t["stream_url"])
                    if expiry and (soonest_expiry is None or expiry < soonest_expiry):
                        soonest_expiry = expiry
                stats["reused"] += len(reusable)
                stats["resolved"] += len(reusable)
                out_posts.append({**post, "tracks": reusable})
                continue
            if soonest_of.get(key, 0.0) > deadline:
                stats["ahead"] += 1

            album_url = album_cache.get(key)
            if album_url:
                stats["cache_hits"] += 1
            else:
                probe = bandcamp_tracks[0]["webpage_url"]
                html = bandcamp.fetch_page(client, probe)
                time.sleep(REQUEST_DELAY)
                album_url = bandcamp.album_url_from_track_page(html, probe) if html else None
                if not album_url:
                    # A standalone single has no parent album - its own page is the source.
                    album_url = probe
                album_cache[key] = album_url

            html = bandcamp.fetch_page(client, album_url)
            time.sleep(REQUEST_DELAY)
            if html is None:
                stats["posts_failed"] += 1
                print(f"{label}: страница альбома недоступна")
                continue

            try:
                album = bandcamp.parse_page(html, album_url)
            except bandcamp.NotBandcamp:
                stats["posts_failed"] += 1
                print(f"{label}: не похоже на bandcamp: {album_url}")
                continue

            by_url = {t.webpage_url: t for t in album.tracks}
            fresh_records = []
            for original in bandcamp_tracks:
                fresh = by_url.get(original["webpage_url"])
                if fresh is None:
                    stats["skipped"] += 1
                    continue
                expiry = bandcamp.stream_expiry(fresh.stream_url)
                if expiry and (soonest_expiry is None or expiry < soonest_expiry):
                    soonest_expiry = expiry
                fresh_records.append(
                    {
                        "id": original["id"],
                        "title": fresh.title or original["title"],
                        "artist": fresh.artist or original.get("artist", ""),
                        "thumbnail": fresh.thumbnail or original.get("thumbnail"),
                        "webpage_url": original["webpage_url"],
                        "album": fresh.album_title or album.title,
                        "album_url": album.url,
                        "stream_url": fresh.stream_url,
                        "duration": fresh.duration,
                    }
                )

            stats["resolved"] += len(fresh_records)
            print(f"{label}: {len(fresh_records)}/{len(bandcamp_tracks)} треков — {album.title[:45]}")
            if fresh_records:
                out_posts.append({**post, "tracks": fresh_records})

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": DATA_VERSION,
        "generated_at": int(time.time()),
        "expires_at": soonest_expiry,
        "channel": CHANNEL,
        "posts": out_posts,
    }
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    CATALOG_DIR.mkdir(parents=True, exist_ok=True)
    with open(ALBUM_CACHE, "w", encoding="utf-8") as f:
        json.dump(album_cache, f, ensure_ascii=False, indent=2)

    size_mb = OUT_FILE.stat().st_size / 1024 / 1024
    print()
    print(f"записано: {OUT_FILE.relative_to(ROOT)}  ({size_mb:.2f} МБ)")
    print(f"  постов: {len(out_posts)}, треков: {stats['resolved']}")
    print(f"  пропущено треков: {stats['skipped']}, постов с ошибкой: {stats['posts_failed']}")
    print(f"  album-ссылок из кеша: {stats['cache_hits']}")
    print(f"  переиспользовано живых ссылок: {stats['reused']} (запросов не потребовалось)")
    print(f"  обновлено заранее, про запас: {stats['ahead']} альбомов")
    if soonest_expiry:
        left = (soonest_expiry - time.time()) / 3600
        print(f"  самая ранняя ссылка протухнет через {left:.1f} ч")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
