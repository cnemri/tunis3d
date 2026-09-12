"""Stream Google Open Buildings v3 polygons for the S2 cells covering Greater
Tunis and keep only footprints inside the bounding box.

OSM building footprints stay authoritative; these ML-detected footprints are
used by build_tiles.py only where OSM has no building.

Output: data/raw/open_buildings.csv  (lat, lon, area_m2, confidence, wkt)
"""
import csv
import gzip
import io
import os
import sys
import time

import requests

from config import BBOX, RAW_DIR

CELLS = ["12fd", "12e3"]
URL = "https://storage.googleapis.com/open-buildings-data/v3/polygons_s2_level_6_gzip_no_header/{tok}_buildings.csv.gz"
MIN_CONFIDENCE = 0.65


def main():
    os.makedirs(RAW_DIR, exist_ok=True)
    out_path = os.path.join(RAW_DIR, "open_buildings.csv")
    w, s, e, n = BBOX
    kept = 0
    seen = 0
    t0 = time.time()
    with open(out_path + ".tmp", "w", newline="") as out:
        writer = csv.writer(out)
        writer.writerow(["latitude", "longitude", "area_in_meters", "confidence", "geometry"])
        for tok in CELLS:
            url = URL.format(tok=tok)
            print(f"streaming {url}", flush=True)
            with requests.get(url, stream=True, timeout=120) as r:
                r.raise_for_status()
                gz = gzip.GzipFile(fileobj=r.raw)
                reader = csv.reader(io.TextIOWrapper(gz, encoding="utf-8", newline=""))
                for row in reader:
                    seen += 1
                    if len(row) < 5:
                        continue
                    try:
                        lat = float(row[0])
                        lon = float(row[1])
                    except ValueError:
                        continue
                    if not (s <= lat <= n and w <= lon <= e):
                        continue
                    conf = float(row[3])
                    if conf < MIN_CONFIDENCE:
                        continue
                    writer.writerow([row[0], row[1], row[2], row[3], row[4]])
                    kept += 1
                    if seen % 500000 == 0:
                        print(f"  {seen} rows scanned, {kept} kept ({time.time() - t0:.0f}s)", flush=True)
    os.replace(out_path + ".tmp", out_path)
    print(f"done: {kept} footprints kept from {seen} rows in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
