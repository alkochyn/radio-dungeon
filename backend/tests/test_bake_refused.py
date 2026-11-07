"""Checks for what the web build does when bandcamp stops serving real pages.

Runs the whole bake against a fake bandcamp in a temporary directory. No network.

    python backend/tests/test_bake_refused.py
"""

import json
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "backend"))

import build_site_data as build  # noqa: E402

HOUR = 3600
BOT_PAGE = "<html><title>Just a moment</title></html>"

failures = []


def check(name, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{'  ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


def page_url(mid):
    return f"https://band{mid}.bandcamp.com/track/song"


def album_url(mid):
    return f"https://band{mid}.bandcamp.com/album/record"


def channel_track(mid):
    return {
        "id": f"t{mid}",
        "title": f"Song {mid}",
        "artist": "Band",
        "webpage_url": page_url(mid),
        "message_id": mid,
        "message_date": "2026-01-01T00:00:00+00:00",
        "message_text": "",
    }


def baked_track(mid, expires):
    return {
        **channel_track(mid),
        "album_url": album_url(mid),
        "stream_url": f"https://t4.bcbits.com/stream/x/mp3-128/{mid}?p=0&ts={int(expires)}&t=y",
        "duration": 60,
    }


def real_page(mid, expires):
    blob = {
        "current": {"title": "Record", "type": "album"},
        "artist": "Band",
        "url": album_url(mid),
        "trackinfo": [
            {
                "title": f"Song {mid}",
                "duration": 60,
                "title_link": "/track/song",
                "streaming": 1,
                "file": {"mp3-128": f"https://t4.bcbits.com/stream/x/mp3-128/{mid}?p=0&ts={int(expires)}&t=z"},
            }
        ],
    }
    return 'x data-tralbum="' + json.dumps(blob).replace('"', "&quot;") + '" y'


def mid_of(url):
    return int(url.split("band")[1].split(".")[0])


def bake(directory, tracks, previous, albums, answer, baked=None):
    """Run the bake once. Returns (posts by message id, requested urls, album cache, outputs)."""
    directory = Path(directory)
    if baked is not None:
        (directory / build.BAKED_NAME).write_text(json.dumps(baked), encoding="utf-8")
    (directory / "tracks.json").write_text(json.dumps(tracks), encoding="utf-8")
    (directory / "albums.json").write_text(json.dumps(albums), encoding="utf-8")
    build.OUT_DIR = directory
    build.OUT_FILE = directory / "posts.json"
    build.CATALOG_DIR = directory
    build.ALBUM_CACHE = directory / "albums.json"
    build.ROOT = directory
    build.REQUEST_DELAY = 0
    build.OUT_FILE.write_text(
        json.dumps({"version": build.DATA_VERSION, "generated_at": time.time() - 2 * HOUR, "posts": previous}),
        encoding="utf-8",
    )
    requested = []

    def fake_fetch(client, url, log=print):
        requested.append(url)
        return answer(url)

    build.bandcamp.fetch_page = fake_fetch
    outputs = directory / "outputs.txt"
    outputs.write_text("", encoding="utf-8")
    os.environ["GITHUB_OUTPUT"] = str(outputs)
    sys.argv = ["build_site_data.py", "--tracks", str(directory / "tracks.json")]
    stdout, sys.stdout = sys.stdout, open(os.devnull, "w", encoding="utf-8")
    try:
        build.main()
    finally:
        sys.stdout.close()
        sys.stdout = stdout
    posts = json.loads(build.OUT_FILE.read_text(encoding="utf-8"))["posts"]
    cache = json.loads(build.ALBUM_CACHE.read_text(encoding="utf-8"))
    values = dict(line.split("=", 1) for line in outputs.read_text(encoding="utf-8").split())
    return {p["message_id"]: p for p in posts}, requested, cache, values


def post_of(track):
    return {"message_id": track["message_id"], "message_date": track["message_date"], "tracks": [track]}


now = time.time()
count = build.BLOCK_AFTER * 5
tracks = [channel_track(m) for m in range(1, count + 1)]
albums = {str(m): album_url(m) for m in range(1, count + 1)}

print("bandcamp не отдаёт страницы")
with tempfile.TemporaryDirectory() as tmp:
    # Half the links are due but still play, half are already dead.
    previous = [post_of(baked_track(m, now + (HOUR if m % 2 else -HOUR))) for m in range(1, count + 1)]
    kept, requested, _, values = bake(tmp, tracks, previous, albums, lambda url: BOT_PAGE)
    check("запросов не больше порога", len(requested) == build.BLOCK_AFTER, f"{len(requested)} из {count}")
    check("живые ссылки остаются", all(m in kept for m in range(1, count + 1, 2)), f"осталось {len(kept)}")
    check("мёртвые выпадают", all(m not in kept for m in range(2, count + 1, 2)))
    check("запуск докладывает о беде", values.get("unhealthy") == "true", str(values))

print("каталог без ссылок")
with tempfile.TemporaryDirectory() as tmp:
    # Every link is dead and bandcamp refuses: posts.json empties, the catalogue must not.
    remembered = [
        {
            "message_id": m,
            "message_date": "2026-01-01T00:00:00+00:00",
            "tracks": [{k: v for k, v in baked_track(m, now).items() if k in build.BAKED_FIELDS}],
        }
        for m in range(1, count + 1)
    ]
    dead = [post_of(baked_track(m, now - HOUR)) for m in range(1, count + 1)]
    kept, _, _, _ = bake(tmp, tracks, dead, albums, lambda url: BOT_PAGE, {"posts": remembered})
    published = json.loads((Path(tmp) / build.PUBLISHED_CATALOG).read_text(encoding="utf-8"))
    published_tracks = [t for p in published["posts"] for t in p["tracks"]]
    check("в posts.json пусто", not kept)
    check("в каталоге всё на месте", len(published_tracks) == count, f"{len(published_tracks)} из {count}")
    check("ссылок в каталоге нет", all("stream_url" not in t for t in published_tracks))
    check("длительность осталась", all(t["duration"] == 60 for t in published_tracks))

with tempfile.TemporaryDirectory() as tmp:
    # A freshly baked album joins the catalogue with the fields a consumer needs.
    bake(tmp, [channel_track(1)], [], {"1": album_url(1)}, lambda url: real_page(1, now + 24 * HOUR))
    published = json.loads((Path(tmp) / build.PUBLISHED_CATALOG).read_text(encoding="utf-8"))
    check("новый альбом попал в каталог", published["posts"][0]["tracks"][0]["webpage_url"] == page_url(1))

print("новый пост, пока bandcamp не отдаёт страницы")
with tempfile.TemporaryDirectory() as tmp:
    kept, requested, cache, _ = bake(tmp, [channel_track(1)], [], {}, lambda url: BOT_PAGE)
    check("пробная страница не кешируется как альбом", "1" not in cache, str(cache))
    check("поста нет", 1 not in kept)

print("редкие ошибки")
with tempfile.TemporaryDirectory() as tmp:
    # Every other album is gone: the run keeps going and the good ones are refreshed.
    def sparse(url):
        mid = mid_of(url)
        return BOT_PAGE if mid % 2 else real_page(mid, now + 24 * HOUR)

    kept, requested, _, _ = bake(tmp, tracks, [], albums, sparse)
    check("ошибки вперемешку с успехами не останавливают", len(requested) == count, f"{len(requested)} из {count}")
    check("живые альбомы обновились", all(m in kept for m in range(2, count + 1, 2)), f"{len(kept)} постов")

print("всё работает")
with tempfile.TemporaryDirectory() as tmp:
    kept, requested, _, values = bake(tmp, tracks, [], albums, lambda url: real_page(mid_of(url), now + 24 * HOUR))
    check("все посты на месте", len(kept) == count, f"{len(kept)} из {count}")
    check("запуск здоров", values.get("unhealthy") == "false", str(values))

if failures:
    print(f"\nне прошло: {len(failures)}")
    raise SystemExit(1)
print("\nвсё прошло")
