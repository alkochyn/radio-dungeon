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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dungeon_catalog  # noqa: E402

# dungeon-catalog's links and albums - see dungeon_catalog.py. Empty variable - not asked.
DUNGEON_CATALOG_URL = dungeon_catalog.URL
fetch_dungeon_catalog = dungeon_catalog.fetch

# Build inputs live outside site/ so that nothing but the player itself gets published.
CATALOG_DIR = ROOT / "catalog"
TRACKS_FILE = CATALOG_DIR / "tracks.json"
ALBUM_CACHE = CATALOG_DIR / "albums.json"
OUT_DIR = ROOT / "site" / "data"
OUT_FILE = OUT_DIR / "posts.json"
# Links die within a day and an album whose links could not be refreshed drops out of
# posts.json. What the albums are does not expire, so it is kept here, committed, and
# published next to posts.json: a consumer that gets its links elsewhere keeps its catalogue
# through a bandcamp block. The names are relative so the checks can bake into a temp dir.
BAKED_NAME = "baked.json"
PUBLISHED_CATALOG = "catalog.json"
BAKED_FIELDS = ("id", "title", "artist", "thumbnail", "webpage_url", "album", "album_url", "duration")

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
# Runs can come from two places: GitHub's own cron and an outside pinger that asks for a
# run through workflow_dispatch (GitHub's cron fires every 4-10h instead of every 2h, so
# a steady pinger is what keeps the planner's 2h assumption true). Whichever comes first
# does the work; a run that finds the previous bake younger than this only refreshes
# what is due and leaves the early budget for later, so two triggers close together do
# not re-mint twice the albums. With the pinger gone the cron runs exactly as before.
FRESH_BAKE = float(os.environ.get("BC_FRESH_BAKE_MINUTES", "90")) * 60
# This many album pages in a row without album data means bandcamp is not serving this
# machine real pages, not that this many albums vanished. The run stops asking: every
# further request would only get the same answer, and a catalogue's worth of them every
# two hours is a good way to keep a block in place. Also the number of failed albums at
# which a run reports itself as unhealthy.
BLOCK_AFTER = int(os.environ.get("BC_BLOCK_AFTER", "10"))
# After a run that hit that wall, the next ones do not ask bandcamp at all for this long:
# a block lasts days, and knocking every two hours only gives it more to count. The runs
# themselves keep going - the channel sync and the publishing do not depend on bandcamp.
BLOCK_BACKOFF = float(os.environ.get("BC_BLOCK_BACKOFF_HOURS", "12")) * 3600
# Once bandcamp answers again every album is overdue at once. A run asks for at most
# this many, newest posts first, until the backlog is gone: a burst of a thousand pages
# from the machine that was just let back in is the surest way to be shut out again.
RECOVERY_CAP = int(os.environ.get("BC_RECOVERY_CAP", "150"))
TIMEOUT = 25
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36 radio-dungeon-player"
)


def adopt_catalog_links(
    posts: list[dict],
    previous_tracks: dict[str, dict],
    known: dict[str, dict],
    links: dict[str, str],
    now: float,
    by_url: dict[str, dict] | None = None,
) -> int:
    """Put outside links into previous_tracks where they live longer. Returns how many.

    A record needs the track's details, not just its link: they come from what was baked
    before, from baked.json for a track whose links have all died, or from the album the
    extension opened (by_url) for a new post. A track with none of these is left to bandcamp.
    """
    adopted = 0
    for post in posts:
        for t in post["tracks"]:
            key = dungeon_catalog.page_key(t["webpage_url"])
            stream = links.get(key)
            expiry = bandcamp.stream_expiry(stream) if stream else None
            if not expiry or expiry <= now:
                continue
            current = previous_tracks.get(t["id"])
            if current and (bandcamp.stream_expiry(current.get("stream_url", "")) or 0) >= expiry:
                continue
            details = current or known.get(t["id"]) or (by_url or {}).get(key)
            if not details:
                continue
            previous_tracks[t["id"]] = {**{f: details.get(f) for f in BAKED_FIELDS}, "id": t["id"], "stream_url": stream}
            adopted += 1
    return adopted


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


def early_budget(previous_generated_at: float | None, now: float) -> int:
    """How many albums this run may re-mint ahead of time. See FRESH_BAKE."""
    if previous_generated_at and now - previous_generated_at < FRESH_BAKE:
        return 0
    return REFRESH_BUDGET


def plan_refresh(soonest_of: dict[str, float], now: float, budget: int | None = None) -> tuple[set[str], int]:
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
    if budget is None:
        budget = REFRESH_BUDGET
    by_urgency = sorted(soonest_of, key=lambda k: soonest_of[k])
    deadline = now + DUE_MARGIN
    refresh = {k for k in by_urgency if soonest_of[k] <= deadline}
    due_count = len(refresh)
    for key in by_urgency:
        if len(refresh) >= budget:
            break
        refresh.add(key)
    return refresh, due_count


def alive_records(tracks: list[dict], previous_tracks: dict[str, dict], now: float) -> list[dict]:
    """What the previous run baked for these tracks and can still play right now."""
    records = (previous_tracks.get(t["id"]) for t in tracks)
    return [r for r in records if r and (bandcamp.stream_expiry(r["stream_url"]) or 0) > now]


def update_baked(baked: dict, posts: list[dict], out_posts: list[dict]) -> dict:
    """Everything ever baked, minus the links, in channel order. Never forgets a track."""
    known = {t["id"]: t for post in baked.get("posts", []) for t in post.get("tracks", [])}
    for post in out_posts:
        for t in post["tracks"]:
            known[t["id"]] = {field: t.get(field) for field in BAKED_FIELDS}
    out = []
    for post in posts:
        tracks = [known[t["id"]] for t in post["tracks"] if t["id"] in known]
        if tracks:
            out.append({"message_id": post["message_id"], "message_date": post["message_date"], "tracks": tracks})
    return {"version": 1, "channel": CHANNEL, "posts": out}


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
    if DUNGEON_CATALOG_URL:
        payload = fetch_dungeon_catalog(DUNGEON_CATALOG_URL)
        outside = dungeon_catalog.clean_links(payload.get("links"))
        by_url = dungeon_catalog.track_details(dungeon_catalog.clean_pages(payload.get("pages")))
        known = {t["id"]: t for p in load_json(CATALOG_DIR / BAKED_NAME, {}).get("posts", []) for t in p.get("tracks", [])}
        adopted = adopt_catalog_links(posts, previous_tracks, known, outside, now, by_url)
        print(f"ссылок из dungeon-catalog: {len(outside)}, взято свежее своих: {adopted}")
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

    budget = early_budget(previous.get("generated_at"), now)
    if budget < REFRESH_BUDGET:
        age = (now - previous["generated_at"]) / 60
        print(f"прошлая выпечка {age:.0f} мин назад - заранее не обновляю, только протухающее")
    refresh, due_count = plan_refresh(soonest_of, now, budget)
    deadline = now + DUE_MARGIN

    # Posts the plan picked but this run leaves alone: they keep whatever still plays.
    refused_at = previous.get("refused_at")
    recovering = bool(previous.get("recovering"))
    waiting = bool(refused_at) and now - refused_at < BLOCK_BACKOFF
    deferred: set[str] = set()
    if waiting:
        deferred = set(refresh)
        print(f"bandcamp отказал {(now - refused_at) / 3600:.1f} ч назад - не спрашиваю до {BLOCK_BACKOFF / 3600:.0f} ч")
    elif recovering:
        # Nothing early until the overdue are done: the early slice is for spreading
        # expiry times, and a backlog has no business paying for it.
        due = sorted((k for k in refresh if soonest_of[k] <= deadline), key=lambda k: int(k) if k.isdigit() else 0, reverse=True)
        deferred = (refresh - set(due)) | set(due[RECOVERY_CAP:])
        if len(due) > RECOVERY_CAP:
            print(f"после блокировки: обновляю {RECOVERY_CAP} самых свежих, остальные {len(due) - RECOVERY_CAP} - в следующие запуски")
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
        "kept_alive": 0,
        "not_asked": 0,
    }
    soonest_expiry = None
    failures_in_row = 0
    response_logged = False

    def note_expiry(stream_url: str) -> None:
        nonlocal soonest_expiry
        expiry = bandcamp.stream_expiry(stream_url)
        if expiry and (soonest_expiry is None or expiry < soonest_expiry):
            soonest_expiry = expiry

    def keep_what_still_plays(post: dict, tracks: list[dict]) -> None:
        # A failed refresh is no reason to throw away links that still work.
        alive = alive_records(tracks, previous_tracks, now)
        for t in alive:
            note_expiry(t["stream_url"])
        stats["kept_alive"] += len(alive)
        stats["resolved"] += len(alive)
        if alive:
            out_posts.append({**post, "tracks": alive})

    def album_failed(post: dict, tracks: list[dict], message: str, html: str | None = None) -> None:
        nonlocal failures_in_row, response_logged
        failures_in_row += 1
        stats["posts_failed"] += 1
        print(message)
        # Once per run: without seeing the answer nobody can tell a block from a redesign.
        if html is not None and not response_logged:
            response_logged = True
            print(f"    ответ, {len(html)} символов: {html.strip()[:300]!r}")
        keep_what_still_plays(post, tracks)

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
                    note_expiry(t["stream_url"])
                stats["reused"] += len(reusable)
                stats["resolved"] += len(reusable)
                out_posts.append({**post, "tracks": reusable})
                continue
            if key in deferred or failures_in_row >= BLOCK_AFTER:
                stats["not_asked"] += 1
                keep_what_still_plays(post, bandcamp_tracks)
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
                # Not a real page, so it says nothing about the album. Remembering the
                # track as its own album would cost this post its other tracks for good.
                if html is None or not bandcamp.has_album_data(html):
                    album_failed(post, bandcamp_tracks, f"{label}: не похоже на bandcamp: {probe}", html)
                    continue
                # A standalone single has no parent album - its own page is the source.
                album_url = bandcamp.album_url_from_track_page(html, probe) or probe
                album_cache[key] = album_url

            html = bandcamp.fetch_page(client, album_url)
            time.sleep(REQUEST_DELAY)
            if html is None:
                album_failed(post, bandcamp_tracks, f"{label}: страница альбома недоступна")
                continue

            try:
                album = bandcamp.parse_page(html, album_url)
            except bandcamp.NotBandcamp:
                album_failed(post, bandcamp_tracks, f"{label}: не похоже на bandcamp: {album_url}", html)
                continue

            failures_in_row = 0
            by_url = {t.webpage_url: t for t in album.tracks}
            fresh_records = []
            for original in bandcamp_tracks:
                fresh = by_url.get(original["webpage_url"])
                if fresh is None:
                    stats["skipped"] += 1
                    continue
                note_expiry(fresh.stream_url)
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

    tripped = failures_in_row >= BLOCK_AFTER
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": DATA_VERSION,
        "generated_at": int(time.time()),
        "expires_at": soonest_expiry,
        "channel": CHANNEL,
        "posts": out_posts,
        # When bandcamp last refused, and whether the backlog after that is not yet gone.
        "refused_at": now if tripped else (refused_at if waiting else None),
        "recovering": tripped or waiting or (recovering and any(soonest_of[k] <= deadline for k in deferred)),
    }
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    CATALOG_DIR.mkdir(parents=True, exist_ok=True)
    with open(ALBUM_CACHE, "w", encoding="utf-8") as f:
        json.dump(album_cache, f, ensure_ascii=False, indent=2)

    # A --limit run has seen a slice of the channel and must not rewrite the whole list.
    if not args.limit:
        baked = update_baked(load_json(CATALOG_DIR / BAKED_NAME, {}), posts, out_posts)
        with open(CATALOG_DIR / BAKED_NAME, "w", encoding="utf-8") as f:
            json.dump(baked, f, ensure_ascii=False, indent=1)
        with open(OUT_DIR / PUBLISHED_CATALOG, "w", encoding="utf-8") as f:
            json.dump(baked, f, ensure_ascii=False, separators=(",", ":"))

    size_mb = OUT_FILE.stat().st_size / 1024 / 1024
    print()
    print(f"записано: {OUT_FILE.relative_to(ROOT)}  ({size_mb:.2f} МБ)")
    print(f"  постов: {len(out_posts)}, треков: {stats['resolved']}")
    print(f"  пропущено треков: {stats['skipped']}, постов с ошибкой: {stats['posts_failed']}")
    print(f"  оставлено живых ссылок после ошибки: {stats['kept_alive']}")
    if tripped:
        print(f"  {BLOCK_AFTER} ошибок подряд - bandcamp не отдаёт страницы, не спрашивал ещё {stats['not_asked']} постов")
    elif stats["not_asked"]:
        print(f"  не спрашивал, отложено: {stats['not_asked']} постов")
    print(f"  album-ссылок из кеша: {stats['cache_hits']}")
    print(f"  переиспользовано живых ссылок: {stats['reused']} (запросов не потребовалось)")
    print(f"  обновлено заранее, про запас: {stats['ahead']} альбомов")
    if soonest_expiry:
        left = (soonest_expiry - time.time()) / 3600
        print(f"  самая ранняя ссылка протухнет через {left:.1f} ч")

    # The run still has to publish what it kept, so a bad bake cannot simply fail here:
    # the workflow flags the run with a warning after the deploy.
    unhealthy = stats["posts_failed"] >= BLOCK_AFTER or waiting
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as f:
            f.write(f"unhealthy={'true' if unhealthy else 'false'}\n")
            f.write(f"failed={stats['posts_failed']}\n")
            f.write(f"not_asked={stats['not_asked']}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
