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

print("\nFailures:", len(failures) or "none")
raise SystemExit(1 if failures else 0)
