"""Bring the catalogue up to date with the channel, without an account and without yt-dlp.

The desktop sync expands an album link into tracks by asking yt-dlp, which is slow and
needs updating forever. The web build does not need it: a bandcamp album page already
lists its tracks, so the same expansion is a single request and a json parse.

Reads the channel through its public web preview (see app/web_sync.py), so it needs no
Telegram account - which is what lets it run unattended in CI.

    TG_DATA_DIR=catalog python tools/sync_catalog.py
"""

import asyncio
import os
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app import bandcamp, store, web_sync  # noqa: E402
from app.config import CHANNEL  # noqa: E402

REQUEST_DELAY = float(os.environ.get("BC_REQUEST_DELAY", "1.0"))
# A link that would not expand is retried for this long, then given up: an album taken
# down for good should not cost a request every two hours forever.
PENDING_DAYS = float(os.environ.get("SYNC_PENDING_DAYS", "30"))
TIMEOUT = 25
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36 radio-dungeon-player"
)


def expand(client: httpx.Client, link: str) -> list[bandcamp.BcTrack]:
    """Turn one bandcamp link into its tracks."""
    html = bandcamp.fetch_page(client, link)
    if html is None:
        return []
    try:
        return bandcamp.parse_page(html, link).tracks
    except (bandcamp.NotBandcamp, ValueError):
        return []


def new_entries(item: dict, tracks: list[bandcamp.BcTrack], known: set[str]) -> list[dict]:
    entries = []
    for t in tracks:
        if t.webpage_url in known:
            continue
        known.add(t.webpage_url)
        entries.append(
            {
                "id": store.track_id(t.webpage_url),
                "webpage_url": t.webpage_url,
                "title": t.title,
                "artist": t.artist,
                "thumbnail": t.thumbnail,
                "message_id": item["id"],
                "message_text": item["text"],
                "message_date": item["date"],
            }
        )
    return entries


async def main() -> int:
    state = store.load_state()
    last_id = state.get("last_id", 0)
    # Links that bandcamp would not expand last time. The cursor still moves past their
    # posts - it has to, or one dead album would hold up the channel - so they wait here
    # and are retried every run. Without this a post that arrived during a block was
    # gone for good: the cursor moved on and nothing ever read it again.
    pending: list[dict] = state.get("pending", [])

    posts = await web_sync.fetch_posts(CHANNEL, last_id)
    print(f"новых постов: {len(posts)}, ждут повтора: {len(pending)}")
    if not posts and not pending:
        return 0

    now = time.time()
    work = list(pending) + [
        {"id": post.id, "date": post.date, "text": post.text, "link": link, "since": now}
        for post in posts
        for link in post.links
        # Only bandcamp can be expanded (and later baked) without yt-dlp; other
        # sources are left out of the web build rather than half-supported.
        if "bandcamp.com" in link
    ]
    known = store.known_urls()
    added_total = 0
    still_pending = []

    headers = {"User-Agent": USER_AGENT, "Accept-Language": "en,ru;q=0.9"}
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True, headers=headers) as client:
        for i, item in enumerate(work, 1):
            print(f"[{i}/{len(work)}] пост {item['id']}: {item['link']}")
            tracks = expand(client, item["link"])
            time.sleep(REQUEST_DELAY)
            if not tracks:
                if now - item["since"] < PENDING_DAYS * 86400:
                    still_pending.append(item)
                    print("    не разобрался - повторю в следующий раз")
                else:
                    print(f"    не разбирается {PENDING_DAYS:.0f} дней - сдаюсь")
                continue
            entries = new_entries(item, tracks, known)
            if entries:
                added_total += len(store.add_tracks(entries))

    # Move the cursor only after a full pass, so an interrupted run re-reads those posts
    # next time instead of silently skipping them.
    if posts:
        state["last_id"] = posts[-1].id
    state["pending"] = still_pending
    store.save_state(state)
    print(f"добавлено треков: {added_total}, курсор: {state['last_id']}, ждут повтора: {len(still_pending)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
