"""Turn the raw OSM + DEM data into per-chunk binary geometry for the client.

Per chunk (one zoom-14 tile) the container holds:
  height      float32 (RES+1)^2   terrain grid, row 0 = north
  wall_*      building facades    pos / col / uv / style / idx
  roof_*      building roofs      pos / col / idx
  road_*      draped road ribbons pos / col / idx
  water_*     water surfaces      pos / idx
  tree_*      vegetation          pos / type / height
"""
import colorsys
import json
import math
import os
import random
import re
import sys
import time
from collections import defaultdict

import numpy as np
from mapbox_earcut import triangulate_float64
from shapely import affinity as shapely_affinity
from shapely import wkt as shapely_wkt
from shapely.geometry import LineString, Point, Polygon, box
from shapely.prepared import prep
from shapely.strtree import STRtree

from config import BBOX, CHUNK_ZOOM, DATA_DIR, RAW_DIR, TILE_DIR, TERRAIN_RES
from dem import DEM
from geo import chunk_key, lonlat_to_tile, lonlat_to_xz, tile_bounds, tiles_in_bbox, xz_to_lonlat
from landmarks_catalog import CATALOG, GENERIC_KINDS

CATALOG_BY_ID = {e["id"]: e for e in CATALOG}
from osm import OSMData, parse_colour, parse_length

MAGIC = b"TUN1"
LEVEL_H = 3.0
# Landmark kinds whose geometry is generated entirely by web/src/landmarks.js.
SKIP_EXTRUDE_KINDS = {"inverted_pyramid", "gate", "clock_tower", "obelisk", "lighthouse", "koubba",
                      "amphitheatre"}
RING_KINDS = {"stadium"}
random.seed(1881)

# --------------------------------------------------------------------------
# Building attribute heuristics
# --------------------------------------------------------------------------
MEDINA_CENTER = lonlat_to_xz(10.1700, 36.7980)
MEDINA_RADIUS = 750.0
CENTER = lonlat_to_xz(10.1830, 36.8000)

DEFAULT_HEIGHTS = {
    "house": 6.5, "detached": 7.0, "villa": 7.0, "semidetached_house": 7.0, "terrace": 7.0,
    "residential": 9.0, "apartments": 15.0, "dormitory": 12.0,
    "commercial": 14.0, "office": 18.0, "retail": 5.0, "supermarket": 6.0, "kiosk": 3.0,
    "industrial": 8.0, "warehouse": 8.0, "factory": 9.0, "hangar": 10.0,
    "school": 8.0, "college": 10.0, "university": 12.0, "hospital": 15.0, "clinic": 9.0,
    "mosque": 8.0, "church": 14.0, "cathedral": 20.0, "synagogue": 10.0, "chapel": 7.0,
    "hotel": 24.0, "garage": 3.0, "garages": 3.0, "shed": 2.6, "hut": 2.6, "roof": 3.5,
    "carport": 2.6, "greenhouse": 3.0, "public": 12.0, "civic": 12.0, "government": 14.0,
    "train_station": 10.0, "transportation": 8.0, "terminal": 12.0, "stadium": 25.0,
    "sports_hall": 10.0, "construction": 6.0, "ruins": 3.0, "bunker": 3.0, "tower": 30.0,
    "service": 3.0, "shrine": 5.0, "cabin": 3.0, "barn": 5.0, "farm_auxiliary": 4.0,
    "grandstand": 12.0, "pavilion": 5.0, "gatehouse": 6.0, "palace": 12.0, "castle": 12.0,
    "fort": 10.0,
}

WHITE_PALETTE = [
    (0.94, 0.93, 0.89), (0.96, 0.95, 0.91), (0.92, 0.90, 0.85), (0.95, 0.92, 0.86),
    (0.90, 0.88, 0.82), (0.93, 0.90, 0.80), (0.97, 0.96, 0.94), (0.89, 0.87, 0.83),
]
OCHRE_PALETTE = [(0.91, 0.84, 0.70), (0.88, 0.80, 0.66), (0.93, 0.87, 0.74), (0.86, 0.78, 0.62)]
GREY_PALETTE = [(0.72, 0.72, 0.70), (0.66, 0.67, 0.66), (0.78, 0.77, 0.74)]

STYLE_BLANK, STYLE_RES, STYLE_OFFICE, STYLE_ARCH, STYLE_INDUSTRIAL, STYLE_MEDINA = 0, 1, 2, 3, 4, 6
SIDI_BOU_SAID = lonlat_to_xz(10.3415, 36.8712)


def building_height(tags, centroid, area):
    h = parse_length(tags.get("height")) or parse_length(tags.get("building:height"))
    if h is None:
        lv = tags.get("building:levels") or tags.get("levels")
        try:
            lv = float(lv)
            h = lv * LEVEL_H + 1.0
            if tags.get("roof:levels"):
                h += float(tags["roof:levels"]) * 2.0
        except (TypeError, ValueError):
            h = None
    if h is None:
        kind = tags.get("building", "yes")
        if kind in DEFAULT_HEIGHTS:
            h = DEFAULT_HEIGHTS[kind]
        else:
            dm = math.hypot(centroid[0] - MEDINA_CENTER[0], centroid[1] - MEDINA_CENTER[1])
            dc = math.hypot(centroid[0] - CENTER[0], centroid[1] - CENTER[1])
            if dm < MEDINA_RADIUS:
                h = 6.5 if area < 400 else 8.0
            elif dc < 1400:
                h = 16.0 if area > 150 else 12.0
            elif area < 40:
                h = 3.2
            elif area < 90:
                h = 5.5
            elif area < 250:
                h = 7.0
            elif area < 800:
                h = 8.5
            else:
                h = 10.0
        # Deterministic jitter so rows of houses are not perfectly flat.
        jitter = int(abs(centroid[0] * 7.31 + centroid[1] * 3.17) * 100) % 1000
        h *= 0.92 + 0.16 * (jitter / 1000.0)
    min_h = parse_length(tags.get("min_height"))
    if min_h is None and tags.get("building:min_level"):
        try:
            min_h = float(tags["building:min_level"]) * LEVEL_H
        except ValueError:
            min_h = None
    return max(2.0, h), max(0.0, min_h or 0.0)


def tame_colour(c):
    """Mapped colours are often pure primaries (#3366FF, red); real render
    and glass are never that saturated."""
    h, s, v = colorsys.rgb_to_hsv(*c)
    return colorsys.hsv_to_rgb(h, min(s, 0.5), min(max(v, 0.22), 0.96))


def building_colour(tags, bid, centroid):
    c = parse_colour(tags.get("building:colour")) or parse_colour(tags.get("colour"))
    if c:
        return tame_colour(c)
    kind = tags.get("building", "yes")
    r = random.Random(bid)
    if kind in ("industrial", "warehouse", "factory", "hangar", "garage", "garages", "shed"):
        return r.choice(GREY_PALETTE)
    dm = math.hypot(centroid[0] - MEDINA_CENTER[0], centroid[1] - MEDINA_CENTER[1])
    if dm < MEDINA_RADIUS or r.random() < 0.72:
        return r.choice(WHITE_PALETTE)
    return r.choice(OCHRE_PALETTE)


def wall_style(tags, height, centroid=None):
    kind = tags.get("building", "yes")
    if centroid is not None and kind in ("yes", "house", "residential", "detached", "apartments", "terrace"):
        dm = math.hypot(centroid[0] - MEDINA_CENTER[0], centroid[1] - MEDINA_CENTER[1])
        ds = math.hypot(centroid[0] - SIDI_BOU_SAID[0], centroid[1] - SIDI_BOU_SAID[1])
        try:
            lv = float(tags["building:levels"]) if tags.get("building:levels") else None
        except ValueError:
            lv = None
        if (dm < MEDINA_RADIUS or ds < 420) and height >= 3.2 and (lv is None or lv <= 3):
            return STYLE_MEDINA
    if kind in ("shed", "hut", "garage", "garages", "roof", "carport", "greenhouse", "wall", "ruins",
                "bunker", "service") or height < 3.2:
        return STYLE_BLANK
    if kind in ("industrial", "warehouse", "factory", "hangar"):
        return STYLE_INDUSTRIAL
    if kind in ("office", "commercial", "hotel") or height > 30:
        return STYLE_OFFICE
    if kind in ("mosque", "church", "cathedral", "synagogue", "palace", "castle", "fort", "train_station") \
            or tags.get("amenity") == "place_of_worship" or tags.get("historic"):
        return STYLE_ARCH
    return STYLE_RES


# --------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------
def ring_coords(ring):
    pts = list(ring.coords)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    # drop duplicate consecutive points
    out = []
    for p in pts:
        if not out or (abs(p[0] - out[-1][0]) > 1e-6 or abs(p[1] - out[-1][1]) > 1e-6):
            out.append(p)
    return out


def signed_area(pts):
    a = 0.0
    n = len(pts)
    for i in range(n):
        x0, z0 = pts[i]
        x1, z1 = pts[(i + 1) % n]
        a += x0 * z1 - x1 * z0
    return 0.5 * a


class MeshBuffer:
    """Accumulates one indexed mesh: positions plus optional attributes."""

    def __init__(self, with_col=False, with_uv=False, with_style=False):
        self.pos, self.col, self.uv, self.style, self.idx = [], [], [], [], []
        self.with_col, self.with_uv, self.with_style = with_col, with_uv, with_style
        self.n = 0

    def add_vertex(self, p, col=None, uv=None, style=0):
        self.pos.extend(p)
        if self.with_col:
            self.col.extend(col)
        if self.with_uv:
            self.uv.extend(uv)
        if self.with_style:
            self.style.append(style)
        self.n += 1
        return self.n - 1

    def add_tri(self, a, b, c):
        self.idx.extend((a, b, c))

    def empty(self):
        return not self.idx

    def sections(self, prefix):
        out = {f"{prefix}_pos": np.asarray(self.pos, dtype=np.float32),
               f"{prefix}_idx": np.asarray(self.idx, dtype=np.uint32)}
        if self.with_col:
            out[f"{prefix}_col"] = np.asarray(self.col, dtype=np.uint8)
        if self.with_uv:
            out[f"{prefix}_uv"] = np.asarray(self.uv, dtype=np.float32)
        if self.with_style:
            out[f"{prefix}_style"] = np.asarray(self.style, dtype=np.uint8)
        return out


def add_walls(buf, pts, base, top, col, style, outward_flip=False):
    """Extrude the closed ring `pts` between base and top.  Facade UVs are in
    metres (u along the ring, v vertical from the base)."""
    n = len(pts)
    if n < 3:
        return
    area = signed_area(pts)
    # For area > 0 the outward normal of edge d is (dz, -dx); holes flip.
    sign = 1.0 if area > 0 else -1.0
    if outward_flip:
        sign = -sign
    u = 0.0
    for i in range(n):
        x0, z0 = pts[i]
        x1, z1 = pts[(i + 1) % n]
        dx, dz = x1 - x0, z1 - z0
        length = math.hypot(dx, dz)
        if length < 0.05:
            continue
        nx, nz = sign * dz / length, -sign * dx / length
        # right vector seen from outside = (nz, -nx); left-to-right if d.right > 0
        ltr = (dx * nz - dz * nx) > 0
        a = buf.add_vertex((x0, base, z0), col, (u, 0.0), style)
        b = buf.add_vertex((x1, base, z1), col, (u + length, 0.0), style)
        c = buf.add_vertex((x1, top, z1), col, (u + length, top - base), style)
        d = buf.add_vertex((x0, top, z0), col, (u, top - base), style)
        if ltr:
            buf.add_tri(a, b, c)
            buf.add_tri(a, c, d)
        else:
            buf.add_tri(a, c, b)
            buf.add_tri(a, d, c)
        u += length


def triangulate(polygon):
    """Earcut a shapely polygon; returns (vertices Nx2, triangle indices)."""
    rings = [ring_coords(polygon.exterior)] + [ring_coords(r) for r in polygon.interiors]
    rings = [r for r in rings if len(r) >= 3]
    if not rings:
        return None, None
    verts = np.array([p for r in rings for p in r], dtype=np.float64)
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    tris = triangulate_float64(verts, ends)
    if len(tris) == 0:
        return None, None
    return verts, tris.reshape(-1, 3)


def add_cap(buf, polygon, y, col, up=True, y_func=None):
    verts, tris = triangulate(polygon)
    if verts is None:
        return
    base = buf.n
    for x, z in verts:
        yy = y_func(x, z) if y_func else y
        buf.add_vertex((x, yy, z), col) if buf.with_col else buf.add_vertex((x, yy, z))
    for a, b, c in tris:
        ax, az = verts[a]
        bx, bz = verts[b]
        cx, cz = verts[c]
        ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
        if (ny > 0) != up:
            b, c = c, b
        buf.add_tri(base + a, base + b, base + c)


def add_pitched_roof(buf, pts, top, ridge_h, col, shape):
    """Simple hipped/pyramidal roof using the centroid as apex."""
    n = len(pts)
    cx = sum(p[0] for p in pts) / n
    cz = sum(p[1] for p in pts) / n
    apex = buf.add_vertex((cx, top + ridge_h, cz), col)
    area = signed_area(pts)
    for i in range(n):
        x0, z0 = pts[i]
        x1, z1 = pts[(i + 1) % n]
        a = buf.add_vertex((x0, top, z0), col)
        b = buf.add_vertex((x1, top, z1), col)
        if area > 0:
            buf.add_tri(a, apex, b)
        else:
            buf.add_tri(a, b, apex)


# --------------------------------------------------------------------------
# Roads
# --------------------------------------------------------------------------
ROAD_CLASSES = {
    "motorway": (11.0, (37, 37, 40), 3), "motorway_link": (6.0, (37, 37, 40), 3),
    "trunk": (10.0, (38, 38, 41), 3), "trunk_link": (6.0, (38, 38, 41), 3),
    "primary": (9.0, (41, 41, 44), 2), "primary_link": (5.5, (41, 41, 44), 2),
    "secondary": (8.0, (43, 43, 46), 2), "secondary_link": (5.0, (43, 43, 46), 2),
    "tertiary": (7.0, (46, 46, 48), 2), "tertiary_link": (5.0, (46, 46, 48), 2),
    "residential": (5.0, (47, 47, 50), 1), "unclassified": (5.0, (47, 47, 50), 1),
    "living_street": (4.0, (69, 64, 59), 1), "service": (3.6, (51, 51, 53), 1),
    "pedestrian": (3.2, (92, 84, 74), 1), "footway": (1.8, (95, 89, 79), 0),
    "path": (1.4, (92, 80, 64), 0), "steps": (1.8, (89, 83, 74), 0),
    "track": (3.0, (100, 87, 69), 0), "cycleway": (2.0, (86, 64, 64), 0),
    "bridleway": (2.0, (100, 87, 69), 0), "corridor": (2.0, (115, 109, 99), 0),
}
RAIL_COLOUR = (78, 72, 66)
RUNWAY_COLOUR = (88, 88, 90)


def road_spec(tags):
    hw = tags.get("highway")
    if hw:
        if tags.get("area") == "yes" or hw in ("proposed", "construction", "raceway", "bus_stop",
                                                 "platform", "elevator", "services", "rest_area"):
            return None
        width, col, rank = ROAD_CLASSES.get(hw, (4.0, (78, 78, 80), 1))
        w = parse_length(tags.get("width"))
        lanes = tags.get("lanes")
        if w:
            width = min(max(w, 1.0), 40.0)
        elif lanes:
            try:
                width = max(width, float(lanes) * 3.3)
            except ValueError:
                pass
        if hw in ("footway", "path", "pedestrian", "steps", "cycleway") and tags.get("surface") in (
                "asphalt", "concrete"):
            col = (120, 118, 116)
        return width, col, rank
    rw = tags.get("railway")
    if rw in ("rail", "light_rail", "tram", "subway", "narrow_gauge"):
        return 3.2 if rw != "rail" else 4.0, RAIL_COLOUR, 2
    aw = tags.get("aeroway")
    if aw == "runway":
        return parse_length(tags.get("width")) or 45.0, RUNWAY_COLOUR, 3
    if aw == "taxiway":
        return parse_length(tags.get("width")) or 23.0, RUNWAY_COLOUR, 2
    return None


# Marking class carried per road vertex (uint8 `style`), drawn by the client
# road shader: 0 plain, 1 kerbs only, 2 dashed centre line, 3 dual carriageway
# edge lines + lane dashes, 4 railway (rails + sleepers), 5 runway/taxiway.
def marking_class(tags, width):
    hw = tags.get("highway")
    if tags.get("railway"):
        return 4
    if tags.get("aeroway"):
        return 5
    if hw in ("motorway", "trunk", "motorway_link", "trunk_link"):
        return 3
    if hw in ("primary", "secondary", "primary_link", "secondary_link") or (hw == "tertiary" and width >= 7.0):
        return 2
    if hw in ("tertiary", "residential", "unclassified", "tertiary_link", "living_street"):
        return 1
    return 0


def densify(pts, max_len):
    out = [pts[0]]
    for i in range(1, len(pts)):
        x0, z0 = pts[i - 1]
        x1, z1 = pts[i]
        d = math.hypot(x1 - x0, z1 - z0)
        n = max(1, int(math.ceil(d / max_len)))
        for k in range(1, n + 1):
            t = k / n
            out.append((x0 + (x1 - x0) * t, z0 + (z1 - z0) * t))
    return out


def offset_dirs(pts):
    """Per-vertex left normals with mitre correction."""
    n = len(pts)
    dirs = []
    for i in range(n - 1):
        dx, dz = pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]
        l = math.hypot(dx, dz) or 1.0
        dirs.append((dx / l, dz / l))
    out = []
    for i in range(n):
        if i == 0:
            d = dirs[0]
        elif i == n - 1:
            d = dirs[-1]
        else:
            ax, az = dirs[i - 1]
            bx, bz = dirs[i]
            sx, sz = ax + bx, az + bz
            l = math.hypot(sx, sz)
            d = (sx / l, sz / l) if l > 1e-6 else dirs[i]
        nx, nz = -d[1], d[0]
        scale = 1.0
        if 0 < i < n - 1:
            ax, az = dirs[i - 1]
            cos_half = nx * (-az) + nz * ax
            if abs(cos_half) > 0.4:
                scale = min(2.0, 1.0 / abs(cos_half))
        out.append((nx * scale, nz * scale))
    return out


# --------------------------------------------------------------------------
# Chunk writer
# --------------------------------------------------------------------------
def write_chunk(path, meta, sections):
    payload = bytearray()
    index = {}
    for name, arr in sections.items():
        arr = np.ascontiguousarray(arr)
        pad = (-len(payload)) % 4
        payload.extend(b"\0" * pad)
        index[name] = {"offset": len(payload), "length": arr.nbytes, "dtype": str(arr.dtype), "count": int(arr.size)}
        payload.extend(arr.tobytes())
    header = json.dumps({"meta": meta, "sections": index}).encode("utf-8")
    header += b" " * ((-len(header)) % 4)
    with open(path, "wb") as f:
        f.write(MAGIC)
        f.write(np.uint32(len(header)).tobytes())
        f.write(header)
        f.write(bytes(payload))
    return 8 + len(header) + len(payload)


# --------------------------------------------------------------------------
# Main build
# --------------------------------------------------------------------------
class Builder:
    def __init__(self):
        self.osm = OSMData.load()
        self.dem = DEM()
        self.chunks = tiles_in_bbox(BBOX, CHUNK_ZOOM)
        self.chunk_set = set(self.chunks)
        self.bounds = {}
        for tx, ty in self.chunks:
            w, s, e, n = tile_bounds(tx, ty, CHUNK_ZOOM)
            x0, z0 = lonlat_to_xz(w, n)
            x1, z1 = lonlat_to_xz(e, s)
            self.bounds[(tx, ty)] = (x0, z0, x1, z1)
        bx0, bz0 = lonlat_to_xz(BBOX[0], BBOX[3])
        bx1, bz1 = lonlat_to_xz(BBOX[2], BBOX[1])
        self.scene_bbox = (bx0, bz0, bx1, bz1)
        self.walls = defaultdict(lambda: MeshBuffer(with_col=True, with_uv=True, with_style=True))
        self.roofs = defaultdict(lambda: MeshBuffer(with_col=True))
        self.roads = defaultdict(lambda: MeshBuffer(with_col=True, with_uv=True, with_style=True))
        # Far-distance skyline: prominent buildings only, flat colours, simplified
        # outlines.  Written as {key}.l.bin and shown by the client beyond the
        # full-geometry streaming radius.
        self.lod = defaultdict(lambda: MeshBuffer(with_col=True))
        self.water = defaultdict(lambda: MeshBuffer())
        self.trees = defaultdict(list)
        self.building_polys = []
        self.landmarks = []
        self.features = []
        self.places = []
        self.stats = defaultdict(int)

    def chunk_of(self, x, z):
        lon, lat = xz_to_lonlat(x, z)
        tx, ty = lonlat_to_tile(lon, lat, CHUNK_ZOOM)
        return int(math.floor(tx)), int(math.floor(ty))

    # ---- buildings ---------------------------------------------------------
    def collect_buildings(self):
        print("Collecting buildings...", flush=True)
        outlines, parts = [], []
        for kind, eid, tags, geom in self.osm.iter_areas(lambda t: "building" in t or "building:part" in t):
            if tags.get("building") == "no" and "building:part" not in tags:
                continue
            polys = list(getattr(geom, "geoms", [geom]))
            for p in polys:
                if p.area < 4.0:
                    continue
                entry = (kind, eid, tags, p)
                if "building:part" in tags and tags.get("building:part") != "no":
                    parts.append(entry)
                else:
                    outlines.append(entry)
        print(f"  {len(outlines)} outlines, {len(parts)} parts")
        # Outlines covered by parts are not extruded themselves.
        part_tree = STRtree([p[3] for p in parts]) if parts else None
        buildings = []
        for kind, eid, tags, poly in outlines:
            if part_tree is not None:
                hits = part_tree.query(poly)
                if len(hits):
                    covered = sum(parts[i][3].intersection(poly).area for i in hits)
                    if covered > 0.45 * poly.area:
                        continue
            buildings.append((kind, eid, tags, poly))
        buildings.extend(parts)
        self.parts = parts
        self.part_tree = part_tree
        self.stats["osm_buildings"] = len(buildings)
        buildings.extend(self.open_buildings(buildings))
        self.building_polys = buildings
        self.stats["buildings"] = len(buildings)
        return buildings

    def open_buildings(self, osm_buildings):
        """Google Open Buildings footprints where OSM has none."""
        path = os.path.join(RAW_DIR, "open_buildings.csv")
        if not os.path.exists(path):
            print("  (no open_buildings.csv, skipping gap fill)")
            return []
        import csv
        tree = STRtree([b[3] for b in osm_buildings]) if osm_buildings else None
        osm_polys = [b[3] for b in osm_buildings]
        added, skipped = [], 0
        t0 = time.time()
        with open(path, newline="") as f:
            reader = csv.DictReader(f)
            for i, row in enumerate(reader):
                try:
                    geom = shapely_wkt.loads(row["geometry"])
                except Exception:
                    continue
                if geom.geom_type != "Polygon":
                    continue
                pts = [lonlat_to_xz(x, y) for x, y in geom.exterior.coords]
                poly = Polygon(pts)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if poly.is_empty or poly.geom_type != "Polygon" or poly.area < 12.0:
                    continue
                if tree is not None:
                    hit = False
                    for j in tree.query(poly):
                        if osm_polys[j].intersection(poly).area > 0.15 * poly.area:
                            hit = True
                            break
                    if hit:
                        skipped += 1
                        continue
                # Simplify the ML outline a little: it is often slightly wobbly.
                poly = poly.simplify(0.35, preserve_topology=True)
                if poly.is_empty or poly.geom_type != "Polygon":
                    continue
                conf = float(row.get("confidence", 0.7))
                added.append(("ob", f"ob{i}", {"building": "yes", "source": "open_buildings", "confidence": conf}, poly))
                if i % 100000 == 0 and i:
                    print(f"  open buildings: {i} rows, {len(added)} added ({time.time() - t0:.0f}s)", flush=True)
        print(f"  open buildings: {len(added)} added, {skipped} overlapped OSM")
        return added

    def build_buildings(self):
        print("Extruding buildings...", flush=True)
        t0 = time.time()
        catalog_index = self.match_landmarks()
        # Bespoke landmarks (inverted pyramid, gates, lighthouse...) are built
        # client-side; drop the small OSM/OB pieces sitting inside their
        # outline so nothing pokes through the procedural model.
        suppress = []
        for lm in self.landmarks:
            if lm.get("kind") in SKIP_EXTRUDE_KINDS and lm.get("footprint"):
                suppress.append(Polygon(lm["footprint"]).buffer(4.0))
            if lm.get("kind") == "stadium" and lm.get("matched") == "area" and lm.get("pitch"):
                # the client builds the bowl around the pitch (see buildStadium)
                big = float(lm["params"].get("height", 25)) >= 30
                r = lm["pitch"]["length"] / 2 + (84 if big else 50) + 6
                suppress.append(Point(*lm["pitch"]["center"]).buffer(r))
        suppress_tree = STRtree(suppress) if suppress else None
        suppressed = 0
        # Catalog colour overrides (e.g. a mapper's #3366FF on a bronze-glass
        # tower) apply to everything inside the landmark outline.
        tints = [(Polygon(lm["footprint"]).buffer(2.0), tuple(CATALOG_BY_ID[lm["id"]]["params"]["colour"]))
                 for lm in self.landmarks
                 if lm.get("footprint") and "colour" in CATALOG_BY_ID.get(lm["id"], {}).get("params", {})]
        tint_tree = STRtree([t[0] for t in tints]) if tints else None
        for i, (kind, eid, tags, poly) in enumerate(self.building_polys):
            c = poly.centroid
            cx, cz = c.x, c.y
            key = self.chunk_of(cx, cz)
            if key not in self.chunk_set:
                continue
            if suppress_tree is not None and (kind, eid) not in catalog_index:
                if any(suppress[j].contains(c) for j in suppress_tree.query(c)):
                    suppressed += 1
                    continue
            area = poly.area
            height, min_h = building_height(tags, (cx, cz), area)
            col = building_colour(tags, eid, (cx, cz))
            if tint_tree is not None:
                for j in tint_tree.query(c):
                    if tints[j][0].contains(c):
                        col = tints[j][1]
                        break
            col8 = tuple(int(v * 255) for v in col)
            ext = ring_coords(poly.exterior)
            if len(ext) < 3:
                continue
            xs = [p[0] for p in ext]
            zs = [p[1] for p in ext]
            hs = self.dem.heights_at(xs, zs)
            ground = float(hs.min())
            base = ground + min_h - (0.6 if min_h == 0 else 0.0)
            top = ground + min_h + height
            style = wall_style(tags, height, (cx, cz))
            lm_id = catalog_index.get((kind, eid))
            feature = self.generic_feature(tags)
            if tags.get("man_made") == "minaret" or tags.get("building") == "minaret" or \
                    tags.get("tower:type") == "minaret":
                self.features.append({
                    "id": None, "kind": "minaret", "osm": f"{kind}/{eid}", "name": tags.get("name"),
                    "footprint": None, "center": [round(cx, 2), round(cz, 2)], "ground": round(ground, 2),
                    "height": parse_length(tags.get("height")) or (float(tags["building:levels"]) * 3.0 + 4 if tags.get("building:levels", "").replace(".", "").isdigit() else None),
                    "width": round(math.sqrt(area), 2), "tags": tags,
                })
                continue
            if lm_id:
                entry = CATALOG_BY_ID[lm_id]
                if entry["kind"] in SKIP_EXTRUDE_KINDS:
                    continue
                if "height" in entry["params"] and (entry["kind"] == "tower" or (
                        not parse_length(tags.get("height")) and not tags.get("building:levels"))):
                    has_parts = self.part_tree is not None and any(
                        self.parts[j][3].intersection(poly).area > 50.0 for j in self.part_tree.query(poly))
                    if entry["kind"] == "tower" and has_parts:
                        pass  # building:part already models the tower on this podium
                    elif entry["kind"] == "tower" and area > 900.0 and float(entry["params"]["height"]) > height:
                        # A whole hotel complex mapped as one footprint: keep it
                        # as the podium and raise a slab tower on the middle.
                        slab_target = float(entry["params"].get("tower_area", 950.0))
                        rect = poly.minimum_rotated_rectangle
                        k = math.sqrt(slab_target / max(rect.area, 1.0))
                        slab = shapely_affinity.scale(rect, xfact=k, yfact=k, origin=rect.centroid).intersection(poly)
                        if slab.geom_type == "MultiPolygon":
                            slab = max(slab.geoms, key=lambda g: g.area)
                        if slab.geom_type == "Polygon" and slab.area > 200:
                            s_top = ground + float(entry["params"]["height"])
                            sb_w, sb_r = self.walls[key], self.roofs[key]
                            add_walls(sb_w, ring_coords(slab.exterior), top - 0.5, s_top, col8, STYLE_OFFICE)
                            add_cap(sb_r, slab, s_top, (200, 198, 192))
                            lb = self.lod[key]
                            add_walls(lb, ring_coords(slab.exterior), top - 0.5, s_top, tuple(int(v * 0.8) for v in col8), 0)
                            add_cap(lb, slab, s_top, (200, 198, 192))
                    else:
                        height = max(height, float(entry["params"]["height"])) if entry["kind"] == "tower" else float(entry["params"]["height"])
                        top = ground + height
                if entry["kind"] in RING_KINDS and not poly.interiors:
                    minx, minz, maxx, maxz = poly.bounds
                    inset = min(28.0, 0.22 * min(maxx - minx, maxz - minz))
                    inner = poly.buffer(-inset)
                    if not inner.is_empty and inner.area > 0.1 * poly.area:
                        poly = poly.difference(inner)
                        if poly.geom_type == "MultiPolygon":
                            poly = max(poly.geoms, key=lambda g: g.area)
                        ext = ring_coords(poly.exterior)
            wb, rb = self.walls[key], self.roofs[key]
            if height >= 9.0 or area >= 350.0:
                sp = poly.simplify(1.2, preserve_topology=True)
                if sp.geom_type == "Polygon" and not sp.is_empty:
                    lext = ring_coords(sp.exterior)
                    if len(lext) >= 3:
                        lb = self.lod[key]
                        # facade textures darken the full-detail walls; match that
                        add_walls(lb, lext, base, top, tuple(int(v * 0.8) for v in col8), 0)
                        add_cap(lb, sp, top, tuple(int(v * 255) for v in (parse_colour(tags.get("roof:colour")) or (0.80, 0.79, 0.76))))
            add_walls(wb, ext, base, top, col8, style)
            for interior in poly.interiors:
                hole = ring_coords(interior)
                if len(hole) >= 3:
                    add_walls(wb, hole, base, top, col8, style, outward_flip=True)
            roof_shape = tags.get("roof:shape", "flat")
            roof_col = parse_colour(tags.get("roof:colour")) or (0.86, 0.85, 0.82)
            roof_col8 = tuple(int(v * 255) for v in roof_col)
            if roof_shape in ("pyramidal", "hipped", "gabled", "dome", "onion") and area < 600 and not poly.interiors:
                ridge = parse_length(tags.get("roof:height")) or min(4.0, 0.25 * math.sqrt(area))
                add_pitched_roof(rb, ext, top, ridge, roof_col8, roof_shape)
            else:
                add_cap(rb, poly, top, roof_col8)
            if lm_id or feature:
                self.features.append({
                    "id": lm_id, "kind": feature or "landmark", "osm": f"{kind}/{eid}",
                    "name": tags.get("name:fr") or tags.get("name") or tags.get("name:en"),
                    "footprint": [[round(x, 2), round(z, 2)] for x, z in ext],
                    "center": [round(cx, 2), round(cz, 2)], "ground": round(ground, 2),
                    "height": round(height, 2), "top": round(top, 2), "area": round(area, 1),
                    "tags": {k: v for k, v in tags.items() if k in (
                        "building", "amenity", "religion", "denomination", "height", "building:levels",
                        "historic", "tourism", "man_made", "name", "name:en", "name:ar", "wikidata")},
                })
            if i % 20000 == 0:
                print(f"  {i}/{len(self.building_polys)} ({time.time() - t0:.0f}s)", flush=True)
        print(f"  done in {time.time() - t0:.0f}s ({suppressed} pieces hidden under bespoke landmarks)")

    def generic_feature(self, tags):
        for name, pred in GENERIC_KINDS.items():
            if pred(tags):
                return name
        return None

    def match_landmarks(self):
        """Map catalog entries to OSM: named buildings first, then named
        non-building areas (archaeological sites, stadiums...), then named
        nodes, then tag-hinted proximity.  Returns {(kind, id): catalog_id}
        for buildings so the extruder can special-case them."""
        index = {}
        used = set()
        named_b = []
        for kind, eid, tags, poly in self.building_polys:
            if kind == "ob":
                continue
            names = " | ".join(v for k, v in tags.items() if k.startswith("name") or k in ("alt_name", "official_name", "designation", "brand", "operator"))
            if names:
                named_b.append((kind, eid, tags, poly, names))
        named_a = []
        for kind, eid, tags, geom in self.osm.iter_areas(lambda t: "name" in t and "building" not in t and (
                "historic" in t or "leisure" in t or "tourism" in t or "aeroway" in t or "amenity" in t or "man_made" in t)):
            poly = max(getattr(geom, "geoms", [geom]), key=lambda g: g.area)
            names = " | ".join(v for k, v in tags.items() if k.startswith("name") or k in ("alt_name", "official_name", "designation", "brand", "operator"))
            named_a.append((kind, eid, tags, poly, names))
        named_n = []
        for nid, tags, (x, z), ll in self.osm.iter_points(lambda t: "name" in t and (
                "historic" in t or "tourism" in t or "man_made" in t or "amenity" in t)):
            names = " | ".join(v for k, v in tags.items() if k.startswith("name") or k in ("alt_name", "official_name", "designation", "brand", "operator"))
            named_n.append((nid, tags, (x, z), names))

        def nearest_regex(items, rx, fx, fz, maxd):
            best, best_d = None, 1e18
            for it in items:
                if not rx.search(it[-1]):
                    continue
                geom = it[3] if len(it) == 5 else None
                if geom is not None:
                    c = geom.centroid
                    x, z = c.x, c.y
                else:
                    x, z = it[2]
                d = math.hypot(x - fx, z - fz)
                if d < maxd and d < best_d:
                    best, best_d = it, d
            return best, best_d

        for entry in CATALOG:
            rx = re.compile(entry["match"], re.I)
            fx, fz = lonlat_to_xz(*entry["lonlat"])
            hint = entry.get("tags", {})
            record = {"id": entry["id"], "name": entry["name"], "kind": entry["kind"], "params": entry["params"]}
            # 1. named building (unless the entry prefers an area, e.g. an aerodrome)
            best = None
            if entry.get("prefer") != "area":
                best, best_d = nearest_regex([b for b in named_b if (b[0], b[1]) not in used], rx, fx, fz, 1500)
            if best is not None:
                kind, eid, tags, poly, _ = best
                index[(kind, eid)] = entry["id"]
                used.add((kind, eid))
                self._record_landmark(record, kind, eid, tags, poly, "name")
                continue
            # 2. named non-building area
            best, best_d = nearest_regex(named_a, rx, fx, fz, 2500)
            if best is not None:
                kind, eid, tags, poly, _ = best
                if entry["kind"] == "stadium":
                    record["pitch"] = self.pitch_in(poly)
                self._record_landmark(record, kind, eid, tags, poly, "area")
                continue
            # 3. named node
            best, best_d = nearest_regex(named_n, rx, fx, fz, 1500)
            if best is not None:
                nid, tags, (x, z), _ = best
                record.update({"osm": f"node/{nid}", "matched": "node", "center": [round(x, 2), round(z, 2)],
                               "lonlat": list(xz_to_lonlat(x, z)), "ground": round(float(self.dem.height_at(x, z)), 2),
                               "footprint": None, "osm_height": parse_length(tags.get("height"))})
                self.landmarks.append(record)
                continue
            # 4. proximity: tag-hinted or (for ordinary kinds) nearest OSM building
            best, best_score = None, 1e18
            for kind, eid, tags, poly in self.building_polys:
                if (kind, eid) in used:
                    continue
                c = poly.centroid
                d = math.hypot(c.x - fx, c.y - fz)
                if d > 120:
                    continue
                tag_hit = bool(hint) and all(tags.get(k) == v for k, v in hint.items())
                if not tag_hit and (entry["kind"] in SKIP_EXTRUDE_KINDS or entry["kind"] in RING_KINDS or kind == "ob"):
                    continue
                score = d - (1000 if tag_hit else 0)
                if score < best_score:
                    best, best_score = (kind, eid, tags, poly), score
            if best is not None:
                kind, eid, tags, poly = best
                index[(kind, eid)] = entry["id"]
                used.add((kind, eid))
                self._record_landmark(record, kind, eid, tags, poly, "proximity")
                continue
            record.update({"osm": None, "matched": "fallback", "center": [round(fx, 2), round(fz, 2)],
                           "lonlat": list(entry["lonlat"]), "ground": round(float(self.dem.height_at(fx, fz)), 2),
                           "footprint": None, "osm_height": None})
            self.landmarks.append(record)
        by = defaultdict(int)
        for l in self.landmarks:
            by[l["matched"]] += 1
        print(f"  landmarks: {dict(by)}")
        return index

    def pitch_in(self, area):
        """Largest leisure=pitch inside a stadium area: centre, long-axis angle
        and size, so the client can orient the bowl on the real field."""
        best = None
        for kind, eid, tags, geom in self.osm.iter_areas(lambda t: t.get("leisure") == "pitch"):
            for p in getattr(geom, "geoms", [geom]):
                if p.area > 2000 and area.contains(p.centroid) and (best is None or p.area > best.area):
                    best = p
        if best is None:
            return None
        rect = best.minimum_rotated_rectangle
        pts = list(rect.exterior.coords)
        e0 = math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1])
        e1 = math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1])
        if e0 >= e1:
            ang = math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0])
            length, width = e0, e1
        else:
            ang = math.atan2(pts[2][1] - pts[1][1], pts[2][0] - pts[1][0])
            length, width = e1, e0
        c = rect.centroid
        return {"center": [round(c.x, 2), round(c.y, 2)], "angle": round(ang, 4),
                "length": round(length, 1), "width": round(width, 1)}

    def _record_landmark(self, record, kind, eid, tags, poly, how):
        c = poly.centroid
        record.update({
            "osm": f"{kind}/{eid}", "matched": how,
            "center": [round(c.x, 2), round(c.y, 2)], "lonlat": list(xz_to_lonlat(c.x, c.y)),
            "ground": round(float(self.dem.height_at(c.x, c.y)), 2),
            "footprint": [[round(x, 2), round(z, 2)] for x, z in ring_coords(poly.exterior)],
            "osm_height": parse_length(tags.get("height")),
            "osm_name": tags.get("name:fr") or tags.get("name"),
        })
        self.landmarks.append(record)

    # ---- point features (minarets, towers, trees, places) -----------------
    def collect_points(self):
        print("Collecting point features...", flush=True)
        for nid, tags, (x, z), ll in self.osm.iter_points(lambda t: True):
            key = self.chunk_of(x, z)
            if key not in self.chunk_set:
                continue
            if tags.get("natural") == "tree":
                self.trees[key].append(self.tree_record(x, z, tags))
                continue
            feature = self.generic_feature(tags)
            if feature:
                self.features.append({
                    "id": None, "kind": feature, "osm": f"node/{nid}", "name": tags.get("name"),
                    "footprint": None, "center": [round(x, 2), round(z, 2)],
                    "ground": round(float(self.dem.height_at(x, z)), 2),
                    "height": parse_length(tags.get("height")), "tags": tags,
                })
            elif tags.get("place") in ("city", "town", "suburb", "neighbourhood", "quarter", "village", "hamlet"):
                self.places.append({"name": tags.get("name:fr") or tags.get("name"), "name_ar": tags.get("name:ar"),
                                    "place": tags["place"], "center": [round(x, 2), round(z, 2)],
                                    "ground": round(float(self.dem.height_at(x, z)), 2)})
            elif tags.get("historic") or tags.get("tourism") in ("attraction", "museum", "viewpoint") or \
                    tags.get("railway") == "station" or tags.get("public_transport") == "station":
                self.features.append({
                    "id": None, "kind": "poi", "osm": f"node/{nid}", "name": tags.get("name:fr") or tags.get("name"),
                    "footprint": None, "center": [round(x, 2), round(z, 2)],
                    "ground": round(float(self.dem.height_at(x, z)), 2), "height": None,
                    "tags": {k: v for k, v in tags.items() if k in ("historic", "tourism", "railway", "name")},
                })
        # Linear features used by the client (city walls, aqueducts)
        for wid, tags, pts in self.osm.iter_lines(lambda t: GENERIC_KINDS["aqueduct"](t) or GENERIC_KINDS["city_wall"](t)):
            kind = "aqueduct" if GENERIC_KINDS["aqueduct"](tags) else "city_wall"
            c = pts[len(pts) // 2]
            self.features.append({
                "id": None, "kind": kind, "osm": f"way/{wid}", "name": tags.get("name"),
                "line": [[round(x, 2), round(z, 2), round(float(self.dem.height_at(x, z)), 2)] for x, z in pts],
                "center": [round(c[0], 2), round(c[1], 2)], "ground": round(float(self.dem.height_at(*c)), 2),
                "height": parse_length(tags.get("height")), "tags": tags,
            })

    def tree_record(self, x, z, tags, forced_type=None):
        genus = (tags.get("genus") or tags.get("species") or tags.get("taxon") or "").lower()
        leaf = tags.get("leaf_type", "")
        if forced_type is not None:
            t = forced_type
        elif any(k in genus for k in ("pinus", "cupressus", "cedrus", "juniperus", "casuarina", "araucaria")) \
                or leaf == "needleleaved":
            t = 2
        elif any(k in genus for k in ("phoenix", "washingtonia", "palm", "chamaerops", "arecaceae")):
            t = 1
        elif "olea" in genus:
            t = 3
        else:
            t = 1 if random.random() < 0.30 else 0
        h = parse_length(tags.get("height"))
        if h is None:
            h = {0: 9.0, 1: 8.0, 2: 12.0, 3: 5.0}[t] * random.uniform(0.75, 1.3)
        y = float(self.dem.height_at(x, z))
        return (x, y, z, t, h)

    # ---- imagery-detected trees -----------------------------------------------
    def import_detected_trees(self, water_polys):
        """Trees detected in the satellite imagery (detect_trees.py), filtered
        against buildings, water and OSM point trees; species by land cover."""
        path = os.path.join(RAW_DIR, "detected_trees.csv")
        if not os.path.exists(path):
            return False
        import csv
        print("Importing detected trees...", flush=True)
        t0 = time.time()
        pts, radii = [], []
        with open(path, newline="") as f:
            for row in csv.DictReader(f):
                x, z = lonlat_to_xz(float(row["lon"]), float(row["lat"]))
                pts.append((x, z))
                radii.append(float(row["radius"]))
        pts = np.array(pts)
        radii = np.array(radii)
        keep = np.ones(len(pts), dtype=bool)
        points = [Point(x, z) for x, z in pts]

        def drop_within(polys, label):
            if not polys:
                return
            tree = STRtree(polys)
            hits = tree.query(points, predicate="within")
            keep[np.unique(hits[0])] = False
            print(f"  dropped {len(np.unique(hits[0]))} inside {label}")

        drop_within([b[3] for b in self.building_polys], "buildings")
        drop_within([p for p in water_polys if p.area > 500], "water")
        # Grass pitches, runways and aprons read as "excess green" / crowns in
        # the imagery but carry no trees.
        no_tree = []
        for kind, eid, tags, geom in self.osm.iter_areas(lambda t: t.get("leisure") in ("pitch", "track")
                                                         or t.get("aeroway") in ("runway", "taxiway", "apron")
                                                         or t.get("landuse") in ("salt_pond", "quarry")):
            for p in getattr(geom, "geoms", [geom]):
                if p.area > 300:
                    no_tree.append(p)
        drop_within(no_tree, "pitches / airfield")
        # OSM point trees take precedence within 4 m
        osm_pts = [(t[0], t[2]) for lst in self.trees.values() for t in lst]
        if osm_pts:
            ot = STRtree([Point(x, z) for x, z in osm_pts])
            hits = ot.query(points, predicate="dwithin", distance=4.0)
            keep[np.unique(hits[0])] = False
        # Land cover classes for species selection
        classes = []
        polys = []
        for kind, eid, tags, geom in self.osm.iter_areas(lambda t: t.get("landuse") in (
                "forest", "orchard", "farmland", "cemetery", "vineyard") or t.get("natural") in ("wood", "scrub")
                or t.get("amenity") == "grave_yard"):
            cls = tags.get("landuse") or tags.get("natural") or "cemetery"
            for p in getattr(geom, "geoms", [geom]):
                polys.append(p)
                classes.append(cls)
        cover = np.full(len(pts), "", dtype=object)
        if polys:
            lt = STRtree(polys)
            hits = lt.query(points, predicate="within")
            for pi, li in zip(hits[0], hits[1]):
                cover[pi] = classes[li]
        coast = lonlat_to_xz(10.30, 36.83)
        rng = random.Random(7)
        n = 0
        for i in np.nonzero(keep)[0]:
            x, z = pts[i]
            key = self.chunk_of(x, z)
            if key not in self.chunk_set:
                continue
            r = radii[i]
            c = cover[i]
            if c in ("forest", "wood"):
                t = 2 if rng.random() < 0.8 else 0
            elif c in ("orchard", "farmland", "vineyard"):
                t = 3
            elif c in ("cemetery", "scrub"):
                t = 2 if rng.random() < 0.6 else 3
            elif r < 2.6:
                near_water = math.hypot(x - coast[0], z - coast[1]) < 9000
                t = 1 if rng.random() < (0.55 if near_water else 0.3) else (3 if rng.random() < 0.4 else 0)
            else:
                t = 0 if rng.random() < 0.85 else 1
            if t == 0:
                h = min(16.0, 3.0 + 2.1 * r) * rng.uniform(0.9, 1.1)
            elif t == 1:
                h = rng.uniform(6.5, 12.0)
            elif t == 2:
                h = min(18.0, 4.0 + 2.4 * r) * rng.uniform(0.9, 1.1)
            else:
                h = rng.uniform(3.5, 5.5)
            self.trees[key].append((float(x), float(self.dem.height_at(x, z)), float(z), t, float(h)))
            n += 1
        print(f"  {n} detected trees kept of {len(pts)} ({time.time() - t0:.0f}s)")
        return True

    # ---- land cover trees --------------------------------------------------
    def scatter_vegetation(self, building_mask):
        print("Scattering vegetation...", flush=True)
        specs = {
            "forest": (110.0, [2, 2, 2, 0]), "wood": (110.0, [2, 2, 0]), "scrub": (400.0, [3, 0]),
            "park": (260.0, [0, 0, 1, 1, 2]), "garden": (220.0, [0, 1]), "orchard": (80.0, [3]),
            "cemetery": (350.0, [2, 2, 1]), "grave_yard": (350.0, [2, 2, 1]), "farmland": (2500.0, [3]),
            "recreation_ground": (900.0, [0, 1]), "golf_course": (900.0, [1, 0, 2]),
            "grass": (1500.0, [1, 0]), "village_green": (600.0, [0, 1]), "greenfield": (3000.0, [3]),
            "plant_nursery": (200.0, [0]), "tree_row": (0.0, [0]),
        }

        def pred(t):
            return t.get("landuse") in specs or t.get("natural") in specs or t.get("leisure") in specs or \
                t.get("amenity") == "grave_yard"

        count = 0
        for kind, eid, tags, geom in self.osm.iter_areas(pred):
            k = tags.get("landuse") or tags.get("natural") or tags.get("leisure") or tags.get("amenity")
            density, types = specs.get(k, (500.0, [0]))
            if density <= 0:
                continue
            polys = list(getattr(geom, "geoms", [geom]))
            for poly in polys:
                n = int(poly.area / density)
                if n <= 0:
                    continue
                n = min(n, 6000)
                minx, minz, maxx, maxz = poly.bounds
                pp = prep(poly)
                rng = random.Random(eid)
                placed, tries = 0, 0
                while placed < n and tries < n * 6:
                    tries += 1
                    x = rng.uniform(minx, maxx)
                    z = rng.uniform(minz, maxz)
                    if not pp.contains(Point(x, z)):
                        continue
                    col, row = self.dem.scene_to_pixel(x, z)
                    ci, ri = int(col), int(row)
                    if 0 <= ri < building_mask.shape[0] and 0 <= ci < building_mask.shape[1] and building_mask[ri, ci]:
                        continue
                    key = self.chunk_of(x, z)
                    if key not in self.chunk_set:
                        continue
                    t = rng.choice(types)
                    h = {0: 9.0, 1: 8.0, 2: 12.0, 3: 4.5}[t] * rng.uniform(0.7, 1.35)
                    self.trees[key].append((x, float(self.dem.height_at(x, z)), z, t, h))
                    placed += 1
                    count += 1
        # tree rows along natural=tree_row lines
        for wid, tags, pts in self.osm.iter_lines(lambda t: t.get("natural") == "tree_row"):
            for x, z in densify(pts, 9.0):
                key = self.chunk_of(x, z)
                if key in self.chunk_set:
                    self.trees[key].append((x, float(self.dem.height_at(x, z)), z, 0, random.uniform(7, 11)))
                    count += 1
        print(f"  {count} scattered trees")

    # ---- roads ---------------------------------------------------------------
    def build_roads(self):
        print("Building roads...", flush=True)
        n_ways = 0
        for wid, tags, pts in self.osm.iter_lines(lambda t: "highway" in t or "railway" in t or "aeroway" in t):
            spec = road_spec(tags)
            if spec is None or len(pts) < 2:
                continue
            if tags.get("tunnel") in ("yes", "building_passage") or tags.get("location") == "underground":
                continue
            if tags.get("railway") and tags.get("service") in ("yard", "siding", "spur"):
                continue
            width, col, rank = spec
            bridge = tags.get("bridge") in ("yes", "viaduct", "aqueduct") or (tags.get("layer", "0").lstrip("-").isdigit() and int(tags.get("layer", "0")) > 0 and tags.get("bridge"))
            dense = densify(pts, 12.0 if rank >= 2 else 20.0)
            xs = [p[0] for p in dense]
            zs = [p[1] for p in dense]
            hs = self.dem.heights_at(xs, zs)
            lift = 0.25 + rank * 0.03
            if bridge:
                # Straight deck between the abutments with an overpass-style hump
                # so it clears whatever runs underneath.
                h0, h1 = float(hs[0]), float(hs[-1])
                seg = [math.hypot(xs[i + 1] - xs[i], zs[i + 1] - zs[i]) for i in range(len(xs) - 1)]
                total = sum(seg) or 1.0
                ts = np.concatenate([[0.0], np.cumsum(seg) / total])
                deck = h0 + (h1 - h0) * ts
                amp = 5.5 if total > 60 else total / 11.0
                deck = deck + amp * np.clip(np.sin(np.pi * ts), 0.0, 1.0) ** 0.6
                ys = np.maximum(deck, hs + 0.3) + lift
            else:
                ys = hs + lift
            offs = offset_dirs(dense)
            half = width / 2.0
            mark = marking_class(tags, width)
            along = 0.0
            for i in range(len(dense) - 1):
                (x0, z0), (x1, z1) = dense[i], dense[i + 1]
                seg_len = math.hypot(x1 - x0, z1 - z0)
                v0, v1 = along, along + seg_len
                along = v1
                mx, mz = (x0 + x1) / 2, (z0 + z1) / 2
                key = self.chunk_of(mx, mz)
                if key not in self.chunk_set:
                    continue
                buf = self.roads[key]
                (n0x, n0z), (n1x, n1z) = offs[i], offs[i + 1]
                y0, y1 = float(ys[i]), float(ys[i + 1])
                # road_uv is 3 floats: u = -1..1 across the ribbon, v = distance
                # along it (m), and the half width (m) so the shader can draw
                # markings at a fixed physical width.
                a = buf.add_vertex((x0 + n0x * half, y0, z0 + n0z * half), col, (-1.0, v0, half), mark)
                b = buf.add_vertex((x0 - n0x * half, y0, z0 - n0z * half), col, (1.0, v0, half), mark)
                c = buf.add_vertex((x1 - n1x * half, y1, z1 - n1z * half), col, (1.0, v1, half), mark)
                d = buf.add_vertex((x1 + n1x * half, y1, z1 + n1z * half), col, (-1.0, v1, half), mark)
                # orientation: normal must point +y
                ny = ((z0 - n0z * half) - (z0 + n0z * half)) * ((x1 - n1x * half) - (x0 + n0x * half)) - \
                     ((x0 - n0x * half) - (x0 + n0x * half)) * ((z1 - n1z * half) - (z0 + n0z * half))
                if ny > 0:
                    buf.add_tri(a, b, c)
                    buf.add_tri(a, c, d)
                else:
                    buf.add_tri(a, c, b)
                    buf.add_tri(a, d, c)
            n_ways += 1
        print(f"  {n_ways} ways")

    # ---- water ---------------------------------------------------------------
    def collect_water(self):
        print("Collecting water...", flush=True)

        def is_water(t):
            if t.get("natural") in ("water", "bay", "strait"):
                return t.get("intermittent") != "yes" and t.get("water") not in ("intermittent",)
            if t.get("waterway") in ("riverbank", "dock", "canal", "boatyard"):
                return True
            if t.get("landuse") in ("reservoir", "basin", "salt_pond", "aquaculture"):
                return True
            if t.get("leisure") == "marina" and t.get("area") != "no":
                return False
            return False

        polys = []
        for kind, eid, tags, geom in self.osm.iter_areas(is_water):
            if tags.get("natural") == "water" and tags.get("water") == "pond" and geom.area < 30:
                continue
            for p in getattr(geom, "geoms", [geom]):
                if p.area > 20:
                    polys.append(p)
        sea = self.osm.sea_polygon(self.scene_bbox)
        if sea is not None:
            for p in getattr(sea, "geoms", [sea]):
                polys.append(p)
            print(f"  sea polygon area {sea.area / 1e6:.1f} km2")
        else:
            print("  WARNING: no sea polygon built from coastline")
        # Wide waterways as ribbons
        for wid, tags, pts in self.osm.iter_lines(lambda t: t.get("waterway") in ("river", "canal") and t.get("tunnel") != "yes"):
            w = parse_length(tags.get("width")) or (12.0 if tags["waterway"] == "canal" else 8.0)
            polys.append(LineString(pts).buffer(w / 2.0, cap_style=2))
        self.water_polys = polys
        self.stats["water_polys"] = len(polys)
        print(f"  {len(polys)} water polygons")
        return polys

    def build_water(self):
        print("Triangulating water...", flush=True)
        tree = STRtree(self.water_polys)
        for key, (x0, z0, x1, z1) in self.bounds.items():
            cb = box(x0, z0, x1, z1)
            buf = self.water[key]
            for i in tree.query(cb):
                poly = self.water_polys[i]
                clipped = poly.intersection(cb)
                if clipped.is_empty:
                    continue
                for p in getattr(clipped, "geoms", [clipped]):
                    if not isinstance(p, Polygon) or p.area < 1.0:
                        continue
                    # Inland water above sea level sits at the lowest terrain along its edge.
                    ext = ring_coords(p.exterior)
                    hs = self.dem.heights_at([q[0] for q in ext], [q[1] for q in ext])
                    level = 0.05
                    lo = float(np.percentile(hs, 10))
                    if lo > 2.5:
                        level = lo + 0.05
                    add_cap(buf, p, level, None)

    # ---- output --------------------------------------------------------------
    def write(self):
        os.makedirs(TILE_DIR, exist_ok=True)
        index = []
        total = 0
        heights = []
        for key in self.chunks:
            tx, ty = key
            grid = self.dem.chunk_grid(tx, ty)
            if grid.shape != (TERRAIN_RES + 1, TERRAIN_RES + 1):
                print(f"  skipping {key}: grid {grid.shape}")
                continue
            heights.append(grid.astype(np.float32).ravel())
            sections = {}
            nb = 0
            if key in self.walls and not self.walls[key].empty():
                sections.update(self.walls[key].sections("wall"))
                sections.update(self.roofs[key].sections("roof"))
                nb = self.walls[key].n
            if key in self.roads and not self.roads[key].empty():
                sections.update(self.roads[key].sections("road"))
            has_water = key in self.water and not self.water[key].empty()
            if key in self.trees and self.trees[key]:
                tr = self.trees[key]
                sections["tree_pos"] = np.array([[t[0], t[1], t[2]] for t in tr], dtype=np.float32).ravel()
                sections["tree_type"] = np.array([t[3] for t in tr], dtype=np.uint8)
                sections["tree_h"] = np.array([t[4] for t in tr], dtype=np.float32)
            x0, z0, x1, z1 = self.bounds[key]
            meta = {"key": chunk_key(tx, ty), "x": tx, "y": ty, "z": CHUNK_ZOOM,
                    "bounds": {"x0": x0, "z0": z0, "x1": x1, "z1": z1},
                    "hmin": float(grid.min()), "hmax": float(grid.max()),
                    "wall_vertices": nb, "trees": len(self.trees.get(key, [])),
                    "has_water": has_water}
            if has_water:
                write_chunk(os.path.join(TILE_DIR, f"{chunk_key(tx, ty)}.w.bin"), meta, self.water[key].sections("water"))
            if key in self.lod and not self.lod[key].empty():
                meta["lod_bytes"] = write_chunk(os.path.join(TILE_DIR, f"{chunk_key(tx, ty)}.l.bin"), meta, self.lod[key].sections("lod"))
                total += meta["lod_bytes"]
            else:
                meta["lod_bytes"] = 0
            size = write_chunk(os.path.join(TILE_DIR, f"{chunk_key(tx, ty)}.bin"), meta, sections) if sections else 0
            meta["bytes"] = size
            total += size
            index.append(meta)
        np.concatenate(heights).astype(np.float32).tofile(os.path.join(TILE_DIR, "heights.bin"))
        with open(os.path.join(TILE_DIR, "index.json"), "w") as f:
            json.dump({"zoom": CHUNK_ZOOM, "res": TERRAIN_RES, "bbox": BBOX, "chunks": index}, f)
        with open(os.path.join(DATA_DIR, "landmarks.json"), "w") as f:
            json.dump({"landmarks": self.landmarks, "features": self.features, "places": self.places}, f)
        print(f"Wrote {len(index)} chunks, {total / 1e6:.1f} MB, {len(self.features)} features, "
              f"{len(self.places)} places")

    def run(self):
        t0 = time.time()
        self.collect_buildings()
        building_mask = self.dem.rasterize([b[3] for b in self.building_polys])
        water_polys = self.collect_water()
        water_mask = self.dem.rasterize(water_polys)
        print("Processing DEM...", flush=True)
        self.dem.process(building_mask, water_mask)
        self.build_buildings()
        self.collect_points()
        if not self.import_detected_trees(water_polys):
            self.scatter_vegetation(building_mask)
        self.build_roads()
        self.build_water()
        self.write()
        print(f"Build finished in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    Builder().run()
