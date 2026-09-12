"""Geodesy helpers shared by every pipeline stage.

Scene frame (mirrors web/src/geo.js):
  x = east (metres), y = up (metres above sea level), z = south (metres).
The frame is a local equirectangular projection around ORIGIN_LON/LAT; over
the ~30 km of Greater Tunis the distortion is well under 0.1 %.
"""
import math

from config import ORIGIN_LAT, ORIGIN_LON, CHUNK_ZOOM

EARTH_R = 6378137.0
_DEG = math.pi / 180.0
_COS0 = math.cos(ORIGIN_LAT * _DEG)


def lonlat_to_xz(lon, lat):
    x = (lon - ORIGIN_LON) * _DEG * EARTH_R * _COS0
    z = -(lat - ORIGIN_LAT) * _DEG * EARTH_R
    return x, z


def xz_to_lonlat(x, z):
    lon = ORIGIN_LON + x / (EARTH_R * _COS0) / _DEG
    lat = ORIGIN_LAT - z / EARTH_R / _DEG
    return lon, lat


def lonlat_to_tile(lon, lat, z):
    """Fractional slippy tile coordinates."""
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lat_r = lat * _DEG
    y = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y


def tile_to_lonlat(x, y, z):
    n = 2 ** z
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def tile_bounds(x, y, z):
    """(west, south, east, north) of an integer tile."""
    w, n = tile_to_lonlat(x, y, z)
    e, s = tile_to_lonlat(x + 1, y + 1, z)
    return w, s, e, n


def tiles_in_bbox(bbox, z):
    w, s, e, n = bbox
    x0, y0 = lonlat_to_tile(w, n, z)
    x1, y1 = lonlat_to_tile(e, s, z)
    return [(x, y) for x in range(int(x0), int(x1) + 1) for y in range(int(y0), int(y1) + 1)]


def chunk_key(x, y):
    return f"{CHUNK_ZOOM}_{x}_{y}"
