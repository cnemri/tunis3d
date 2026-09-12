"""Bare-earth style processing of the Terrarium mosaic plus the exact sampling
model the web client uses, so buildings and roads sit on the rendered surface.
"""
import json
import os

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

from config import CHUNK_ZOOM, TERRAIN_DIR, TERRAIN_RES
from geo import lonlat_to_tile, xz_to_lonlat


class DEM:
    def __init__(self):
        self.raw = np.load(os.path.join(TERRAIN_DIR, "dem.npy"))
        with open(os.path.join(TERRAIN_DIR, "dem.json")) as f:
            self.meta = json.load(f)
        self.px = self.meta["tile_px"]
        self.x0 = self.meta["x0"]
        self.y0 = self.meta["y0"]
        self.step = self.px // TERRAIN_RES  # DEM pixels per terrain grid cell
        self.ground = None
        self.grid = None

    # ---- pixel space ------------------------------------------------------
    def scene_to_pixel(self, x, z):
        lon, lat = xz_to_lonlat(x, z)
        tx, ty = lonlat_to_tile(lon, lat, CHUNK_ZOOM)
        return (tx - self.x0) * self.px, (ty - self.y0) * self.px  # (col, row) fractional

    def scene_polygon_to_pixels(self, geom):
        polys = getattr(geom, "geoms", [geom])
        out = []
        for p in polys:
            if p.is_empty:
                continue
            ext = [self.scene_to_pixel(x, z) for x, z in p.exterior.coords]
            holes = [[self.scene_to_pixel(x, z) for x, z in r.coords] for r in p.interiors]
            out.append((ext, holes))
        return out

    def rasterize(self, geoms, value=255):
        img = Image.new("L", (self.raw.shape[1], self.raw.shape[0]), 0)
        draw = ImageDraw.Draw(img)
        holes_img = None
        for g in geoms:
            for ext, holes in self.scene_polygon_to_pixels(g):
                if len(ext) >= 3:
                    draw.polygon(ext, fill=value)
                for h in holes:
                    if len(h) >= 3:
                        if holes_img is None:
                            holes_img = Image.new("L", img.size, 0)
                        ImageDraw.Draw(holes_img).polygon(h, fill=255)
        mask = np.asarray(img, dtype=np.uint8) > 0
        if holes_img is not None:
            mask &= ~(np.asarray(holes_img, dtype=np.uint8) > 0)
        return mask

    # ---- processing -------------------------------------------------------
    def process(self, building_mask=None, water_mask=None):
        dem = self.raw.copy()
        # Void fill: SRTM voids decode as absurd negatives.
        bad = dem < -30
        if bad.any():
            filled = ndimage.median_filter(np.where(bad, 0, dem), size=5)
            dem[bad] = filled[bad]
        dem = np.maximum(dem, -3.0)

        # SRTM is a surface model: under dense housing it reads the roof tops.
        # Take a local minimum inside the built-up mask to approximate ground.
        if building_mask is not None:
            built = ndimage.binary_dilation(building_mask, iterations=3)
            dem_min = ndimage.minimum_filter(dem, size=7)
            dem_min = ndimage.gaussian_filter(dem_min, 1.2)
            weight = ndimage.gaussian_filter(built.astype(np.float32), 2.0)
            dem = dem * (1 - weight) + dem_min * weight

        dem = ndimage.gaussian_filter(dem, 0.9)

        if water_mask is not None:
            # Flatten the seabed / lake bed slightly below the water surface, and
            # pull shoreline pixels down so the water plane never floats over land.
            dem[water_mask] = np.minimum(dem[water_mask], -1.5)
            shore = ndimage.binary_dilation(water_mask, iterations=1) & ~water_mask
            dem[shore] = np.minimum(dem[shore], 0.4)
        self.ground = dem.astype(np.float32)

        # The client renders (TERRAIN_RES+1)^2 vertices per tile: sample the
        # ground exactly where those vertices are so everything else can be
        # placed by bilinear lookup on this grid.
        rows = np.arange(0, dem.shape[0] + 1, self.step) - 0.5
        cols = np.arange(0, dem.shape[1] + 1, self.step) - 0.5
        rr, cc = np.meshgrid(rows, cols, indexing="ij")
        self.grid = ndimage.map_coordinates(self.ground, [rr, cc], order=1, mode="nearest").astype(np.float32)
        return self.ground

    # ---- sampling (mirrors web/src/terrain.js sampleHeight) --------------
    def height_at(self, x, z):
        col, row = self.scene_to_pixel(x, z)
        gx, gz = col / self.step, row / self.step
        return self._bilinear(gx, gz)

    def heights_at(self, xs, zs):
        xs = np.asarray(xs, dtype=np.float64)
        zs = np.asarray(zs, dtype=np.float64)
        cols = np.empty_like(xs)
        rows = np.empty_like(zs)
        for i in range(len(xs)):
            cols[i], rows[i] = self.scene_to_pixel(xs[i], zs[i])
        return ndimage.map_coordinates(self.grid, [rows / self.step, cols / self.step], order=1, mode="nearest")

    def _bilinear(self, gx, gz):
        g = self.grid
        i = int(np.clip(np.floor(gx), 0, g.shape[1] - 2))
        j = int(np.clip(np.floor(gz), 0, g.shape[0] - 2))
        tx = float(np.clip(gx - i, 0, 1))
        tz = float(np.clip(gz - j, 0, 1))
        return float((g[j, i] * (1 - tx) + g[j, i + 1] * tx) * (1 - tz)
                     + (g[j + 1, i] * (1 - tx) + g[j + 1, i + 1] * tx) * tz)

    def chunk_grid(self, tx, ty):
        """(TERRAIN_RES+1)^2 heights for chunk (tx, ty), row 0 = north."""
        r0 = (ty - self.y0) * TERRAIN_RES
        c0 = (tx - self.x0) * TERRAIN_RES
        return self.grid[r0:r0 + TERRAIN_RES + 1, c0:c0 + TERRAIN_RES + 1]
