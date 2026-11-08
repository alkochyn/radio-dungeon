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


def bake(directory, tracks, previous, albums, answer, baked=None, state=None, outside=None, pages=None):
    """Run the bake once. Returns (posts by message id, requested urls, album cache, outputs).

    outside, pages - links and albums dungeon-catalog hands out; none by default, and never
    the real service.
    """
    directory = Path(directory)
    build.fetch_dungeon_catalog = lambda url: {"links": dict(outside or {}), "pages": dict(pages or {})}
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
        json.dumps({"version": build.DATA_VERSION, "generated_at": time.time() - 2 * HOUR, "posts": previous, **(state or {})}),
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

def written(directory):
    return json.loads((Path(directory) / "posts.json").read_text(encoding="utf-8"))


print("после отказа bandcamp - пауза")
with tempfile.TemporaryDirectory() as tmp:
    dead = [post_of(baked_track(m, now - HOUR)) for m in range(1, count + 1)]
    bake(tmp, tracks, dead, albums, lambda url: BOT_PAGE)
    after = written(tmp)
    check("отказ запомнен", bool(after.get("refused_at")) and after.get("recovering") is True, str({k: after.get(k) for k in ("refused_at", "recovering")}))

    state = {"refused_at": after["refused_at"], "recovering": True}
    _, requested, _, values = bake(tmp, tracks, dead, albums, lambda url: BOT_PAGE, state=state)
    check("через два часа bandcamp не спрашивает вовсе", requested == [], f"{len(requested)} запросов")
    check("время отказа не сдвинулось", written(tmp).get("refused_at") == after["refused_at"])
    check("запуск всё ещё помечен", values.get("unhealthy") == "true")

    state = {"refused_at": now - 13 * HOUR, "recovering": True}
    _, requested, _, _ = bake(tmp, tracks, dead, albums, lambda url: BOT_PAGE, state=state)
    check("через 12 часов пробует снова, и снова не больше порога", len(requested) == build.BLOCK_AFTER, f"{len(requested)}")

print("bandcamp снова отвечает - восстановление порциями")
with tempfile.TemporaryDirectory() as tmp:
    saved_cap = build.RECOVERY_CAP
    build.RECOVERY_CAP = 10
    try:
        dead = [post_of(baked_track(m, now - HOUR)) for m in range(1, count + 1)]
        state = {"refused_at": now - 13 * HOUR, "recovering": True}
        answer = lambda url: real_page(mid_of(url), now + 24 * HOUR)  # noqa: E731
        kept, requested, _, _ = bake(tmp, tracks, dead, albums, answer, state=state)
        check("за запуск не больше порции", len(requested) == 10, f"{len(requested)}")
        check("начинает с самых свежих", sorted(kept) == list(range(count - 9, count + 1)), str(sorted(kept)))
        check("пока хвост не разобран, восстановление продолжается", written(tmp).get("recovering") is True)

        # Хвост разобран - дальше обычный режим.
        fresh = [post_of(baked_track(m, now + 20 * HOUR)) for m in range(1, count + 1)]
        bake(tmp, tracks, fresh, albums, answer, state={"refused_at": None, "recovering": True})
        check("хвоста нет - восстановление кончилось", written(tmp).get("recovering") is False)
    finally:
        build.RECOVERY_CAP = saved_cap

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

print("ссылки из dungeon-catalog")
with tempfile.TemporaryDirectory() as tmp:
    # Bandcamp refuses, every link the run has is dead; the server holds fresh ones for odd posts.
    remembered = [
        {"message_id": m, "message_date": "2026-01-01T00:00:00+00:00", "tracks": [{k: v for k, v in baked_track(m, now).items() if k in build.BAKED_FIELDS}]}
        for m in range(1, count + 1)
    ]
    dead = [post_of(baked_track(m, now - HOUR)) for m in range(1, count + 1)]
    fresh = lambda m: f"https://t4.bcbits.com/stream/x/mp3-128/{m}?p=0&ts={int(now + 20 * HOUR)}&t=srv"  # noqa: E731
    # Другое написание адреса: заглавные в домене и косая черта в конце.
    outside = {f"https://Band{m}.bandcamp.com/track/song/": fresh(m) for m in range(1, count + 1, 2)}
    outside["https://band2.bandcamp.com/track/song"] = "https://evil.example/stream/x?ts=9999999999"
    outside["https://band4.bandcamp.com/track/song"] = f"https://t4.bcbits.com/stream/x?ts={int(now - HOUR)}"
    kept, _, _, _ = bake(tmp, tracks, dead, albums, lambda url: BOT_PAGE, {"posts": remembered}, outside=outside)
    check("посты со ссылками с сервера играют", all(kept.get(m, {}).get("tracks", [{}])[0].get("stream_url") == fresh(m) for m in range(1, count + 1, 2)), f"{len(kept)} постов")
    check("чужие и протухшие ссылки не взяты", all(m not in kept for m in range(2, count + 1, 2)))
    check("у взятых треков все поля на месте", all(set(build.BAKED_FIELDS) <= set(kept[m]["tracks"][0]) for m in kept))

    # Пауза после отказа: bandcamp не спрашиваем, а ссылки с сервера всё равно идут в дело.
    state = {"refused_at": now - HOUR, "recovering": True}
    kept, requested, _, _ = bake(tmp, tracks, dead, albums, lambda url: BOT_PAGE, {"posts": remembered}, state=state, outside=outside)
    check("во время паузы тоже играют", len(kept) == len(range(1, count + 1, 2)) and requested == [], f"{len(kept)} постов, {len(requested)} запросов")

    # Своя ссылка живёт дольше серверной - остаётся своя.
    longer = [post_of(baked_track(m, now + 23 * HOUR)) for m in range(1, count + 1)]
    kept, _, _, _ = bake(tmp, tracks, longer, albums, lambda url: BOT_PAGE, {"posts": remembered}, state=state, outside=outside)
    check("ссылка дольше серверной не заменяется", all("&t=srv" not in kept[m]["tracks"][0]["stream_url"] for m in kept), f"{len(kept)} постов")

print("трек без сведений")
with tempfile.TemporaryDirectory() as tmp:
    # Never baked and not in baked.json: a link alone says nothing about the title or length.
    outside = {page_url(1): f"https://t4.bcbits.com/stream/x/mp3-128/1?p=0&ts={int(now + 20 * HOUR)}&t=srv"}
    kept, _, _, _ = bake(tmp, tracks[:1], [], {"1": album_url(1)}, lambda url: BOT_PAGE, {"posts": []}, outside=outside)
    check("без сведений о треке ссылку не берёт", 1 not in kept)

print("новый пост из альбома dungeon-catalog")
with tempfile.TemporaryDirectory() as tmp:
    # Never baked, not in baked.json, bandcamp refuses - but the extension opened the album.
    stream1 = f"https://t4.bcbits.com/stream/x/mp3-128/1?p=0&ts={int(now + 20 * HOUR)}&t=srv"
    pages = {
        album_url(1): {
            "album": album_url(1),
            "title": "Record",
            "artist": "Band",
            "cover": "https://f4.bcbits.com/img/a1_5.jpg",
            "tracks": [{"url": page_url(1), "title": "Song 1", "artist": "Band", "duration": 61.5}],
        }
    }
    kept, _, _, _ = bake(tmp, tracks[:1], [], {"1": album_url(1)}, lambda url: BOT_PAGE, {"posts": []}, outside={page_url(1): stream1}, pages=pages)
    record = kept.get(1, {}).get("tracks", [{}])[0]
    check("пост играет", record.get("stream_url") == stream1, str(record))
    check("с названием альбома, длительностью и обложкой", (record.get("album"), record.get("duration"), record.get("thumbnail")) == ("Record", 61.5, "https://f4.bcbits.com/img/a1_5.jpg"), str(record))
    published = json.loads((Path(tmp) / build.PUBLISHED_CATALOG).read_text(encoding="utf-8"))
    check("и попал в каталог", [p["message_id"] for p in published["posts"]] == [1])

print("всё работает")
with tempfile.TemporaryDirectory() as tmp:
    kept, requested, _, values = bake(tmp, tracks, [], albums, lambda url: real_page(mid_of(url), now + 24 * HOUR))
    check("все посты на месте", len(kept) == count, f"{len(kept)} из {count}")
    check("запуск здоров", values.get("unhealthy") == "false", str(values))

if failures:
    print(f"\nне прошло: {len(failures)}")
    raise SystemExit(1)
print("\nвсё прошло")
