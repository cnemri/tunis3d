"""Run the whole Tunis 3D data pipeline in order.

    ./.venv/bin/python pipeline/run_all.py [--force] [--skip-imagery] [--skip-trees]

Steps (each is skipped when its output already exists, unless --force):
  1. fetch_terrain        AWS Terrarium DEM tiles  -> data/terrain/dem.npy
  2. download PBF         Geofabrik tunisia-latest -> data/raw/tunisia-latest.osm.pbf
  3. extract_osm          PBF -> data/raw/osm_pbf/tunis.json
  4. fetch_open_buildings Google Open Buildings v3 -> data/raw/open_buildings.csv
  5. fetch_imagery        Esri World Imagery z15-17 -> data/imagery/
  6. detect_trees         tree crowns from imagery -> data/raw/detected_trees.csv
  7. build_tiles          everything -> data/tiles/, data/landmarks.json
"""
import os
import subprocess
import sys
import time

import requests

from config import IMAGERY_DIR, RAW_DIR, TERRAIN_DIR, TILE_DIR

HERE = os.path.dirname(os.path.abspath(__file__))
PBF_URL = "https://download.geofabrik.de/africa/tunisia-latest.osm.pbf"
PBF = os.path.join(RAW_DIR, "tunisia-latest.osm.pbf")


def run(script, *args):
    t0 = time.time()
    print(f"\n=== {script} {' '.join(args)}", flush=True)
    subprocess.run([sys.executable, os.path.join(HERE, script), *args], check=True, cwd=HERE)
    print(f"=== {script} done in {time.time() - t0:.0f}s", flush=True)


def download_pbf():
    os.makedirs(RAW_DIR, exist_ok=True)
    print(f"\n=== downloading {PBF_URL}", flush=True)
    with requests.get(PBF_URL, stream=True, timeout=120) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        done = 0
        with open(PBF + ".tmp", "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
                done += len(chunk)
                if total:
                    print(f"\r  {done / 1e6:.0f}/{total / 1e6:.0f} MB", end="", flush=True)
    print()
    os.replace(PBF + ".tmp", PBF)


def main():
    force = "--force" in sys.argv
    steps = [
        (os.path.join(TERRAIN_DIR, "dem.npy"), lambda: run("fetch_terrain.py")),
        (PBF, download_pbf),
        (os.path.join(RAW_DIR, "osm_pbf", "tunis.json"), lambda: run("extract_osm.py")),
        (os.path.join(RAW_DIR, "open_buildings.csv"), lambda: run("fetch_open_buildings.py")),
    ]
    if "--skip-imagery" not in sys.argv:
        steps.append((os.path.join(IMAGERY_DIR, "17"), lambda: run("fetch_imagery.py", "15", "16", "17")))
    if "--skip-trees" not in sys.argv:
        steps.append((os.path.join(RAW_DIR, "detected_trees.csv"), lambda: run("detect_trees.py")))
    steps.append((os.path.join(TILE_DIR, "index.json"), lambda: run("build_tiles.py")))

    for output, fn in steps:
        if os.path.exists(output) and not force and not output.endswith("index.json"):
            print(f"skip (exists): {os.path.relpath(output, HERE)}")
            continue
        fn()
    print("\npipeline complete")


if __name__ == "__main__":
    main()
