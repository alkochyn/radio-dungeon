"""Checks for the refresh planner in the web build.

The planner decides which albums a scheduled run re-fetches from bandcamp. Getting it
wrong is expensive in both directions: too eager and every run walks the whole
catalogue, too lazy and links die before their turn comes and tracks stop playing.

No network, no fixtures - just arithmetic on expiry times.

    python backend/tests/test_refresh_plan.py
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "backend"))

import build_site_data as build  # noqa: E402

HOUR = 3600
TTL = 24 * HOUR
INTERVAL = 6 * HOUR  # the cron in build-site.yml

failures = []


def check(name, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{'  ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


print("планировщик обновления")

now = 1_000_000.0

# Anything that cannot survive until the next run is refreshed even when the budget is
# long gone - correctness first, cost second.
overdue = {f"p{i}": now - HOUR for i in range(build.REFRESH_BUDGET + 200)}
refresh, due = build.plan_refresh(overdue, now)
check("просроченное обновляется всё, лимит не действует",
      len(refresh) == len(overdue) and due == len(overdue),
      f"{len(refresh)} из {len(overdue)}")

# A run with nothing due still spends itself, or the herd never breaks up.
comfortable = {f"p{i}": now + TTL - HOUR for i in range(1000)}
refresh, due = build.plan_refresh(comfortable, now)
check("когда ничего не горит, всё равно берётся запас",
      due == 0 and len(refresh) == build.REFRESH_BUDGET,
      f"срочных {due}, взято {len(refresh)}")

# The early ones are the soonest, not an arbitrary slice: refreshing whatever comes to
# hand would leave the actual front of the queue to fall due together anyway.
mixed = {f"p{i}": now + 9 * HOUR + i * 60 for i in range(1000)}
refresh, due = build.plan_refresh(mixed, now)
expected = {f"p{i}" for i in range(build.REFRESH_BUDGET)}
check("заранее берутся самые ближние к протуханию", refresh == expected)

# Never baked at all reads as maximally urgent.
fresh_post = {"old": now + TTL - HOUR, "new": 0.0}
refresh, due = build.plan_refresh(fresh_post, now)
check("новый пост всегда попадает в обновление", "new" in refresh and due == 1)

# The whole point: run the schedule forward over a catalogue minted in one sitting and
# check that the burst flattens out and nothing dies on the way.
state = {f"p{i}": now + 9 * HOUR for i in range(996)}
clock = now
sizes = []
expired = 0
for _ in range(16):
    refresh, due = build.plan_refresh(state, clock)
    expired += sum(1 for v in state.values() if v < clock)
    sizes.append(len(refresh))
    for key in refresh:
        state[key] = clock + TTL
    clock += INTERVAL

check("ни одна ссылка не протухла за 4 суток", expired == 0, f"протухло {expired}")
check("пиковый прогон меньше катастрофы", max(sizes) < 800, f"пик {max(sizes)} альбомов")
check("после раскачки прогоны ровные", max(sizes[4:]) <= build.REFRESH_BUDGET + 100,
      f"после раскачки {min(sizes[4:])}-{max(sizes[4:])}")


# A push only publishes; the spreading work belongs to the scheduled runs, so those
# builds run with no budget at all. What must never drop out is the due set - a link
# that dies between runs is a track that will not play, whatever triggered the build.
saved_budget = build.REFRESH_BUDGET
build.REFRESH_BUDGET = 0
mixed_urgency = {"dying": now - HOUR, "fine": now + TTL - HOUR}
refresh, due = build.plan_refresh(mixed_urgency, now)
check("без бюджета протухающее всё равно обновляется",
      refresh == {"dying"} and due == 1, str(sorted(refresh)))
refresh, due = build.plan_refresh({"fine": now + TTL - HOUR}, now)
check("без бюджета и без срочного запросов нет", refresh == set() and due == 0)
build.REFRESH_BUDGET = saved_budget


# --- the planner and the bake loop together ----------------------------------------
# The planner splits the catalogue into "fetch this" and "keep what you have", and the
# loop walks both in one pass. Checked apart they each looked right, while the loop
# rebound the dict of kept records to its list of fresh ones on the first fetch, and
# every reuse after that died. So this runs main() over a catalogue arranged to put a
# fetch before a reuse - the order that breaks - with the network stubbed out.

import json  # noqa: E402
import time  # noqa: E402
import tempfile  # noqa: E402

from app import bandcamp  # noqa: E402

print()
print("запекание целиком, без сети")

ALBUM_A = "https://x.bandcamp.com/album/a"
ALBUM_B = "https://x.bandcamp.com/album/b"


def stream(tid, ts):
    return f"https://t4.bcbits.com/stream/{tid}/mp3-128/{tid}?p=0&ts={int(ts)}&t=a&token=b"


def catalogue_track(tid, mid, album):
    return {
        "id": tid,
        "title": tid,
        "artist": "Artist",
        "webpage_url": f"{album}/track/{tid}",
        "message_id": mid,
        "message_date": "2026-01-01T00:00:00",
        "message_text": "",
    }


def kept(tid, ts):
    return {
        "id": tid, "title": tid, "artist": "Artist", "album": "B",
        "album_url": ALBUM_B, "webpage_url": f"{ALBUM_B}/track/{tid}",
        "stream_url": stream(tid, ts), "duration": 1, "thumbnail": None,
    }


with tempfile.TemporaryDirectory() as tmpname:
    tmp = Path(tmpname)
    real_now = time.time()
    keep_ts = real_now + 20 * HOUR

    # Post 1 was never baked and has to be fetched. Post 2 has most of its life left and
    # has to be kept - and it comes second, after the fetch.
    (tmp / "tracks.json").write_text(json.dumps([
        catalogue_track("a1", 1, ALBUM_A), catalogue_track("a2", 1, ALBUM_A),
        catalogue_track("b1", 2, ALBUM_B), catalogue_track("b2", 2, ALBUM_B),
    ]), encoding="utf-8")
    (tmp / "albums.json").write_text(
        json.dumps({"1": ALBUM_A, "2": ALBUM_B}), encoding="utf-8")
    (tmp / "posts.json").write_text(json.dumps({
        "version": build.DATA_VERSION,
        "posts": [{
            "message_id": 2, "message_date": "2026-01-01T00:00:00", "message_text": "",
            "telegram_url": None, "tracks": [kept("b1", keep_ts), kept("b2", keep_ts)],
        }],
    }), encoding="utf-8")

    def fake_parse(html, page_url):
        return bandcamp.BcAlbum(
            url=ALBUM_A, title="A", artist="Artist",
            tracks=[bandcamp.BcTrack(
                webpage_url=f"{ALBUM_A}/track/{tid}", title=tid, artist="Artist",
                stream_url=stream(tid, real_now + 24 * HOUR), duration=1,
                album_url=ALBUM_A, album_title="A") for tid in ("a1", "a2")],
        )

    saved = (build.OUT_FILE, build.OUT_DIR, build.ALBUM_CACHE, build.ROOT,
             build.REQUEST_DELAY, build.REFRESH_BUDGET,
             bandcamp.fetch_page, bandcamp.parse_page)
    build.OUT_FILE = tmp / "posts.json"
    build.OUT_DIR = tmp
    build.ALBUM_CACHE = tmp / "albums.json"
    build.ROOT = tmp
    build.REQUEST_DELAY = 0.0
    build.REFRESH_BUDGET = 1  # only the neediest, so post 2 must take the reuse path
    bandcamp.fetch_page = lambda client, url, log=print: "<html/>"
    bandcamp.parse_page = fake_parse

    sys.argv = ["build_site_data.py", "--tracks", str(tmp / "tracks.json")]
    crash = None
    try:
        build.main()
    except Exception as exc:  # noqa: BLE001 - reporting it is the whole point
        crash = f"{type(exc).__name__}: {exc}"
    finally:
        (build.OUT_FILE, build.OUT_DIR, build.ALBUM_CACHE, build.ROOT,
         build.REQUEST_DELAY, build.REFRESH_BUDGET,
         bandcamp.fetch_page, bandcamp.parse_page) = saved

    check("выпечка и переиспользование в одном проходе не падают", crash is None, crash or "")
    if crash is None:
        written = json.loads((tmp / "posts.json").read_text(encoding="utf-8"))
        by_id = {p["message_id"]: p for p in written["posts"]}
        check("оба поста дошли до файла", set(by_id) == {1, 2}, str(sorted(by_id)))
        if set(by_id) == {1, 2}:
            check("скачанный пост принёс свежие ссылки",
                  len(by_id[1]["tracks"]) == 2
                  and all(str(int(real_now + 24 * HOUR)) in t["stream_url"] for t in by_id[1]["tracks"]))
            check("переиспользованный пост сохранил свои",
                  [t["stream_url"] for t in by_id[2]["tracks"]]
                  == [stream("b1", keep_ts), stream("b2", keep_ts)])

print("\nFailures:", len(failures) or "none")
raise SystemExit(1 if failures else 0)
