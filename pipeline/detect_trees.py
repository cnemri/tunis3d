"""Detect tree canopies in the cached zoom-17 satellite tiles (~1.2 m/px).

OSM only maps a few thousand individual trees in Tunis; the avenues of ficus,
the palms along the lake and the suburban gardens are all visible in the
imagery though.  An excess-green index picks vegetation, dark/textured
vegetation is treated as canopy (lawns are lighter), and local maxima of the
blurred mask become trees with an estimated crown radius.

Output: data/raw/detected_trees.csv  (lon, lat, radius_m)
"""
import csv
import os
import time

import numpy as np
from PIL import Image
from scipy import ndimage

from config import BBOX, IMAGERY_DIR, RAW_DIR
from geo import tile_to_lonlat, tiles_in_bbox

Z = 17
MIN_SEP_PX = 6          # ~7 m between detected trees
EXG_THRESHOLD = 26      # excess green 2G-R-B (0..255 scale)
MAX_BRIGHTNESS = 135    # canopies are darker than lawns / pitches
MIN_CROWN_PX = 4        # ignore specks (weeds, painted lines)


def analyse_tile(x, y):
    path = os.path.join(IMAGERY_DIR, str(Z), str(x), f"{y}.jpg")
    if not os.path.exists(path):
        return []
    img = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    exg = 2 * g - r - b
    bright = (r + g + b) / 3
    veg = (exg > EXG_THRESHOLD) & (g > 35) & (bright < MAX_BRIGHTNESS) & (g > b + 6)
    # Bright saturated green = sports pitch / painted surface, not a tree.
    veg &= ~((exg > 70) & (bright > 110))
    if veg.sum() < MIN_CROWN_PX:
        return []
    veg = ndimage.binary_opening(veg, iterations=1)
    lab, n = ndimage.label(veg)
    if n == 0:
        return []
    sizes = ndimage.sum(veg, lab, index=np.arange(1, n + 1))
    keep = np.isin(lab, np.nonzero(sizes >= MIN_CROWN_PX)[0] + 1)
    if not keep.any():
        return []
    dist = ndimage.distance_transform_edt(keep)
    smooth = ndimage.gaussian_filter(dist, 1.0)
    peaks = (smooth == ndimage.maximum_filter(smooth, size=MIN_SEP_PX)) & keep & (smooth > 0.8)
    py, px = np.nonzero(peaks)
    out = []
    n_tile = 2 ** Z
    for yy, xx in zip(py, px):
        lon, lat = tile_to_lonlat(x + (xx + 0.5) / 256.0, y + (yy + 0.5) / 256.0, Z)
        radius = float(min(7.0, max(1.5, dist[yy, xx] * 1.2)))
        out.append((lon, lat, radius))
    return out


def main():
    tiles = tiles_in_bbox(BBOX, Z)
    print(f"scanning {len(tiles)} zoom-{Z} tiles")
    t0 = time.time()
    total = 0
    out_path = os.path.join(RAW_DIR, "detected_trees.csv")
    with open(out_path + ".tmp", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["lon", "lat", "radius"])
        for i, (x, y) in enumerate(tiles):
            for lon, lat, radius in analyse_tile(x, y):
                w.writerow([f"{lon:.6f}", f"{lat:.6f}", f"{radius:.1f}"])
                total += 1
            if i % 1000 == 0:
                print(f"  {i}/{len(tiles)} tiles, {total} trees ({time.time() - t0:.0f}s)", flush=True)
    os.replace(out_path + ".tmp", out_path)
    print(f"done: {total} trees in {time.time() - t0:.0f}s -> {out_path}")


if __name__ == "__main__":
    main()
