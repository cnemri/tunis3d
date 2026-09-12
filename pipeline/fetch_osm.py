"""Download OpenStreetMap data for Greater Tunis through the Overpass API.

The bounding box is split into small cells and each (theme, cell) response is
cached under data/raw/osm so that the download can be resumed.  Themes are
kept separate so a heavy building query never delays roads or water.
"""
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

from config import BBOX, OVERPASS_CELL, OVERPASS_URLS, RAW_DIR

THEMES = {
    "buildings": (
        'way["building"];relation["building"];'
        'way["building:part"];relation["building:part"];'
    ),
    "transport": (
        'way["highway"];way["railway"];way["aeroway"];relation["aeroway"];'
        'way["man_made"~"^(pier|breakwater|bridge|embankment)$"];'
        'way["barrier"~"^(city_wall|wall)$"];'
    ),
    "land": (
        'way["natural"];relation["natural"];'
        'way["landuse"];relation["landuse"];'
        'way["leisure"];relation["leisure"];'
        'way["waterway"];relation["waterway"];'
        'way["amenity"~"^(parking|school|university|hospital|grave_yard|marketplace)$"];'
        'relation["amenity"~"^(university|hospital)$"];'
        'way["place"~"^(square)$"];'
        'relation["place"~"^(square)$"];'
    ),
    "points": (
        'node["natural"="tree"];'
        'node["man_made"~"^(minaret|tower|lighthouse|mast|chimney|water_tower|flagpole|obelisk|monument)$"];'
        'way["man_made"~"^(minaret|tower|lighthouse|water_tower|obelisk|monument)$"];'
        'node["historic"];node["tourism"];node["amenity"="place_of_worship"];'
        'node["amenity"="fountain"];way["amenity"="fountain"];'
        'node["highway"="street_lamp"];node["place"];'
        'node["public_transport"="station"];node["railway"="station"];'
    ),
}

HEADERS = {"User-Agent": "tunis3d-pipeline/0.1 (Greater Tunis 3D city; local research use)"}

_lock = threading.Lock()
_endpoint_idx = [0]


def _next_endpoint():
    with _lock:
        url = OVERPASS_URLS[_endpoint_idx[0] % len(OVERPASS_URLS)]
        _endpoint_idx[0] += 1
        return url


def query(theme, cell, out_path, retries=6):
    w, s, e, n = cell
    body = f"[out:json][timeout:300][bbox:{s},{w},{n},{e}];({THEMES[theme]});out body;>;out skel qt;"
    for attempt in range(retries):
        url = _next_endpoint()
        try:
            r = requests.post(url, data={"data": body}, headers=HEADERS, timeout=240)
        except requests.RequestException as exc:
            print(f"  [{theme} {w:.2f},{s:.2f}] {exc} (attempt {attempt + 1})", file=sys.stderr)
            time.sleep(5 * (attempt + 1))
            continue
        if r.status_code == 200:
            try:
                data = r.json()
            except ValueError:
                print(f"  [{theme} {w:.2f},{s:.2f}] bad JSON from {url}", file=sys.stderr)
                time.sleep(5)
                continue
            if "remark" in data and "runtime error" in data["remark"]:
                print(f"  [{theme} {w:.2f},{s:.2f}] {data['remark']}", file=sys.stderr)
                time.sleep(10)
                continue
            tmp = out_path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(data, f)
            os.replace(tmp, out_path)
            return len(data.get("elements", []))
        wait = 20 if r.status_code in (429, 504) else 5
        print(f"  [{theme} {w:.2f},{s:.2f}] HTTP {r.status_code} from {url}, waiting {wait}s",
              file=sys.stderr)
        time.sleep(wait * (attempt + 1))
    raise RuntimeError(f"gave up on {theme} {cell}")


def cells():
    w0, s0, e0, n0 = BBOX
    out = []
    lat = s0
    while lat < n0 - 1e-9:
        lon = w0
        while lon < e0 - 1e-9:
            out.append((round(lon, 4), round(lat, 4),
                        round(min(lon + OVERPASS_CELL, e0), 4), round(min(lat + OVERPASS_CELL, n0), 4)))
            lon += OVERPASS_CELL
        lat += OVERPASS_CELL
    return out


def main(themes=None):
    themes = themes or list(THEMES)
    out_dir = os.path.join(RAW_DIR, "osm")
    os.makedirs(out_dir, exist_ok=True)
    jobs = []
    for theme in themes:
        for cell in cells():
            name = f"{theme}_{cell[0]:.2f}_{cell[1]:.2f}.json"
            path = os.path.join(out_dir, name)
            if not os.path.exists(path):
                jobs.append((theme, cell, path))
    print(f"{len(jobs)} Overpass requests to run")
    done = [0]
    t0 = time.time()

    def work(job):
        theme, cell, path = job
        n = query(theme, cell, path)
        with _lock:
            done[0] += 1
            print(f"  {done[0]}/{len(jobs)} {theme} {cell[0]:.2f},{cell[1]:.2f}: {n} elements "
                  f"({time.time() - t0:.0f}s)", flush=True)

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(work, jobs))
    print("OSM download complete")


if __name__ == "__main__":
    main(sys.argv[1:] or None)
