"""Pin index.html to the exact app.js and style.css it was built with.

GitHub Pages serves everything with max-age=600, and a browser expires those ten
minutes independently per file. So right after a deploy a visitor can end up holding
yesterday's index.html together with today's app.js - markup without the elements the
new script reaches for. The script throws, nothing renders, and the page just sits
there empty. That is exactly what happened after the Chaos Radio button landed.

Stamping the asset urls with a content hash makes the pair atomic: whichever
index.html a browser has, it asks for the assets that belong to it.

Run after the site data is baked, before the artifact is uploaded. It rewrites the
working copy only - the committed index.html keeps plain references so that opening
site/index.html locally still works.
"""

import hashlib
import re
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site"
INDEX = SITE / "index.html"
ASSETS = ("app.js", "style.css")


def digest(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()[:10]


def main() -> int:
    if not INDEX.exists():
        print(f"нет {INDEX}")
        return 1

    html = INDEX.read_text(encoding="utf-8")
    for name in ASSETS:
        asset = SITE / name
        if not asset.exists():
            print(f"нет {asset}")
            return 1
        stamp = digest(asset)
        # Match the bare reference only, so running this twice cannot stack suffixes.
        pattern = re.compile(r'(["\'])' + re.escape(name) + r'(\?v=[0-9a-f]+)?\1')
        html, count = pattern.subn(lambda m: f'{m.group(1)}{name}?v={stamp}{m.group(1)}', html)
        if not count:
            print(f"в index.html не нашлось ссылки на {name}")
            return 1
        print(f"{name} -> ?v={stamp}  ({count} ссылк.)")

    INDEX.write_text(html, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
