"""Checks that the channel sync does not lose a post whose album bandcamp refused.

Runs tools/sync_catalog.py against a temp data dir with the channel and bandcamp faked.

    python backend/tests/test_sync_pending.py
"""

import asyncio
import json
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
DATA = Path(tempfile.mkdtemp())
os.environ["TG_DATA_DIR"] = str(DATA)
os.environ["BC_REQUEST_DELAY"] = "0"
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "backend"))

import sync_catalog as sync  # noqa: E402
from app import bandcamp  # noqa: E402
from app.sync_core import Post  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{'  ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


def album(n):
    return f"https://band{n}.bandcamp.com/album/x"


def run(channel, refused):
    """One sync. channel: posts after the cursor; refused: album links bandcamp will not show."""
    async def fetch_posts(_channel, last_id):
        return [p for p in channel if p.id > last_id]

    def expand(_client, link):
        if link in refused:
            return []
        return [bandcamp.BcTrack(webpage_url=link.replace("/album/x", "/track/a"), title="a", artist="Band",
                                 stream_url="", duration=1, album_url=link, album_title="X")]

    sync.web_sync.fetch_posts = fetch_posts
    sync.expand = expand
    stdout, sys.stdout = sys.stdout, open(os.devnull, "w", encoding="utf-8")
    try:
        asyncio.run(sync.main())
    finally:
        sys.stdout.close()
        sys.stdout = stdout
    state = json.loads((DATA / "state.json").read_text(encoding="utf-8"))
    tracks = json.loads((DATA / "tracks.json").read_text(encoding="utf-8")) if (DATA / "tracks.json").exists() else []
    return state, {t["message_id"] for t in tracks}


channel = [Post(id=n, text=f"post {n}", date="2026-11-07T00:00:00+00:00", links=[album(n)]) for n in (1, 2, 3)]

print("bandcamp отказал на посте 2")
state, posted = run(channel, {album(2)})
check("курсор ушёл вперёд", state["last_id"] == 3, str(state["last_id"]))
check("пост 2 ждёт повтора", [p["id"] for p in state["pending"]] == [2], str(state["pending"]))
check("посты 1 и 3 в каталоге", posted == {1, 3}, str(posted))

print("новых постов нет, bandcamp ещё отказывает")
state, posted = run(channel, {album(2)})
check("пост 2 всё ещё ждёт", [p["id"] for p in state["pending"]] == [2])

print("bandcamp снова отдаёт страницы")
state, posted = run(channel, set())
check("пост 2 попал в каталог", posted == {1, 2, 3}, str(posted))
check("ждущих больше нет", state["pending"] == [])

print("альбом не разбирается месяц")
old = {"id": 9, "date": None, "text": "", "link": album(9), "since": time.time() - 31 * 86400}
(DATA / "state.json").write_text(json.dumps({"last_id": 3, "pending": [old]}), encoding="utf-8")
state, _ = run(channel, {album(9)})
check("сдаётся и больше не просит", state["pending"] == [])

if failures:
    print(f"\nне прошло: {len(failures)}")
    raise SystemExit(1)
print("\nвсё прошло")
