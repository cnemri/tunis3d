"""Download Terrarium-encoded elevation tiles (AWS Terrain Tiles, SRTM-derived)
for the bounding box and assemble them into one float32 mosaic.

Output: data/terrain/dem.npy  (rows x cols, metres)
        data/terrain/dem.json (tile origin so the mosaic can be georeferenced)
"""
import io
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
from PIL import Image

from config import BBOX, CHUNK_ZOOM, TERRAIN_DIR, TERRARIUM_URL
from geo import tiles_in_bbox

TILE_PX = 256
MARGIN = 1  # extra ring of tiles so chunk edges can be interpolated


def fetch_tile(z, x, y, cache_dir, retries=4):
    path = os.path.join(cache_dir, f"{z}_{x}_{y}.png")
    if os.path.exists(path):
        return path
    url = TERRARIUM_URL.format(z=z, x=x, y=y)
    for attempt in range(retries):
        try:
            r = requests.get(url, timeout=30)
            if r.status_code == 200:
                with open(path, "wb") as f:
                    f.write(r.content)
                return path
            if r.status_code == 404:
                return None
        except requests.RequestException as exc:  # pragma: no cover
            print(f"  retry {x},{y}: {exc}", file=sys.stderr)
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"failed to download {url}")


def decode(path):
    if path is None:
        return np.zeros((TILE_PX, TILE_PX), dtype=np.float32)
    img = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    return img[..., 0] * 256.0 + img[..., 1] + img[..., 2] / 256.0 - 32768.0


def main():
    z = CHUNK_ZOOM
    os.makedirs(TERRAIN_DIR, exist_ok=True)
    cache_dir = os.path.join(TERRAIN_DIR, "terrarium")
    os.makedirs(cache_dir, exist_ok=True)

    tiles = tiles_in_bbox(BBOX, z)
    xs = [t[0] for t in tiles]
    ys = [t[1] for t in tiles]
    x0, x1 = min(xs) - MARGIN, max(xs) + MARGIN
    y0, y1 = min(ys) - MARGIN, max(ys) + MARGIN
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    print(f"DEM: zoom {z}, tiles x {x0}..{x1}, y {y0}..{y1} ({nx * ny} tiles)")

    mosaic = np.zeros((ny * TILE_PX, nx * TILE_PX), dtype=np.float32)
    jobs = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]

    def work(xy):
        x, y = xy
        return x, y, decode(fetch_tile(z, x, y, cache_dir))

    with ThreadPoolExecutor(max_workers=12) as pool:
        for i, (x, y, arr) in enumerate(pool.map(work, jobs)):
            r, c = (y - y0) * TILE_PX, (x - x0) * TILE_PX
            mosaic[r:r + TILE_PX, c:c + TILE_PX] = arr
            if i % 40 == 0:
                print(f"  {i}/{len(jobs)}")

    np.save(os.path.join(TERRAIN_DIR, "dem.npy"), mosaic)
    meta = {"zoom": z, "x0": x0, "y0": y0, "nx": nx, "ny": ny, "tile_px": TILE_PX}
    with open(os.path.join(TERRAIN_DIR, "dem.json"), "w") as f:
        json.dump(meta, f)
    print(f"DEM saved: {mosaic.shape}, min {mosaic.min():.1f} m, max {mosaic.max():.1f} m")


if __name__ == "__main__":
    main()
