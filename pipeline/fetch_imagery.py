"""Optional: pre-download Esri World Imagery tiles into data/imagery/{z}/{x}/{y}.jpg
so the viewer loads instantly and works offline.  The client falls back to the
live tile service for anything not cached.

usage: fetch_imagery.py [zooms...]        default: 15 16 17
       fetch_imagery.py 18 --core         zoom 18 only for the central core
"""
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import requests

from config import BBOX, IMAGERY_DIR, IMAGERY_URL
from geo import tiles_in_bbox

CORE_BBOX = (10.14, 36.77, 10.36, 36.89)  # Medina .. Sidi Bou Said
HEADERS = {"User-Agent": "tunis3d-pipeline/0.1"}


def fetch(z, x, y):
    path = os.path.join(IMAGERY_DIR, str(z), str(x), f"{y}.jpg")
    if os.path.exists(path):
        return 0
    os.makedirs(os.path.dirname(path), exist_ok=True)
    url = IMAGERY_URL.format(z=z, x=x, y=y)
    for attempt in range(3):
        try:
            r = requests.get(url, headers=HEADERS, timeout=30)
            if r.status_code == 200 and r.content[:2] == b"\xff\xd8":
                with open(path, "wb") as f:
                    f.write(r.content)
                return 1
            if r.status_code == 404:
                return 0
        except requests.RequestException:
            pass
        time.sleep(1 + attempt)
    return 0


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    zooms = [int(a) for a in args] or [15, 16, 17]
    bbox = CORE_BBOX if "--core" in sys.argv else BBOX
    for z in zooms:
        tiles = tiles_in_bbox(bbox, z)
        print(f"zoom {z}: {len(tiles)} tiles", flush=True)
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=8) as pool:
            n = sum(pool.map(lambda t: fetch(z, *t), tiles))
        print(f"  downloaded {n} new tiles in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
