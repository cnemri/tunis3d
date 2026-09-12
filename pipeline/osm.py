"""Load the cached Overpass responses and assemble them into shapely geometry."""
import glob
import json
import os
import re

from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import linemerge, unary_union, polygonize

from config import RAW_DIR
from geo import lonlat_to_xz


class OSMData:
    def __init__(self):
        self.nodes = {}      # id -> (lon, lat)
        self.node_tags = {}  # id -> tags (only tagged nodes)
        self.ways = {}       # id -> {"nodes": [...], "tags": {...}}
        self.rels = {}       # id -> {"members": [...], "tags": {...}}

    @classmethod
    def load(cls, pattern="*.json"):
        data = cls()
        # Prefer the complete Geofabrik-derived extract over the Overpass cells.
        files = sorted(glob.glob(os.path.join(RAW_DIR, "osm_pbf", pattern)))
        if not files:
            files = sorted(glob.glob(os.path.join(RAW_DIR, "osm", pattern)))
        for i, path in enumerate(files):
            with open(path) as f:
                doc = json.load(f)
            for el in doc.get("elements", []):
                t = el["type"]
                if t == "node":
                    data.nodes[el["id"]] = (el["lon"], el["lat"])
                    if "tags" in el:
                        data.node_tags[el["id"]] = el["tags"]
                elif t == "way":
                    if el["id"] not in data.ways or "tags" in el:
                        data.ways[el["id"]] = {"nodes": el.get("nodes", []), "tags": el.get("tags", {})}
                elif t == "relation":
                    data.rels[el["id"]] = {"members": el.get("members", []), "tags": el.get("tags", {})}
            if i % 20 == 0:
                print(f"  loaded {i + 1}/{len(files)} files", flush=True)
        print(f"OSM: {len(data.nodes)} nodes, {len(data.ways)} ways, {len(data.rels)} relations")
        return data

    # ---- geometry helpers ------------------------------------------------
    def way_coords(self, way_id, scene=True):
        way = self.ways.get(way_id)
        if not way:
            return None
        pts = []
        for nid in way["nodes"]:
            ll = self.nodes.get(nid)
            if ll is None:
                continue
            pts.append(lonlat_to_xz(*ll) if scene else ll)
        return pts if len(pts) >= 2 else None

    def way_polygon(self, way_id):
        pts = self.way_coords(way_id)
        if not pts or len(pts) < 4 or pts[0] != pts[-1]:
            if pts and len(pts) >= 3:
                pts = pts + [pts[0]]
            else:
                return None
        poly = Polygon(pts)
        if not poly.is_valid:
            poly = poly.buffer(0)
        return poly if not poly.is_empty else None

    def relation_multipolygon(self, rel_id):
        rel = self.rels.get(rel_id)
        if not rel:
            return None
        outers, inners = [], []
        for m in rel["members"]:
            if m["type"] != "way":
                continue
            pts = self.way_coords(m["ref"])
            if not pts:
                continue
            (inners if m.get("role") == "inner" else outers).append(LineString(pts))
        if not outers:
            return None

        def rings(lines):
            if not lines:
                return []
            merged = linemerge(unary_union(lines)) if len(lines) > 1 else lines[0]
            geoms = getattr(merged, "geoms", [merged])
            out = []
            for g in geoms:
                if g.is_ring or (len(g.coords) >= 4 and g.coords[0] == g.coords[-1]):
                    out.append(Polygon(g.coords))
                elif len(g.coords) >= 3:
                    out.append(Polygon(list(g.coords) + [g.coords[0]]))
            return out

        outer_polys = [p for p in rings(outers) if p.area > 0]
        inner_polys = [p for p in rings(inners) if p.area > 0]
        result = []
        for op in outer_polys:
            holes = [ip.exterior.coords for ip in inner_polys if op.contains(ip.representative_point())]
            poly = Polygon(op.exterior.coords, holes)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if not poly.is_empty:
                result.append(poly)
        if not result:
            return None
        geom = unary_union(result) if len(result) > 1 else result[0]
        return geom if not geom.is_empty else None

    def area_geometry(self, kind, el_id):
        """Polygon/MultiPolygon for a way or relation."""
        if kind == "way":
            return self.way_polygon(el_id)
        return self.relation_multipolygon(el_id)

    def iter_areas(self, predicate):
        """Yield (kind, id, tags, geometry) for ways/relations matching predicate(tags)."""
        for wid, way in self.ways.items():
            tags = way["tags"]
            if tags and predicate(tags) and len(way["nodes"]) >= 4 and way["nodes"][0] == way["nodes"][-1]:
                geom = self.way_polygon(wid)
                if geom is not None:
                    yield "way", wid, tags, geom
        for rid, rel in self.rels.items():
            tags = rel["tags"]
            if tags and predicate(tags) and tags.get("type") in ("multipolygon", None):
                geom = self.relation_multipolygon(rid)
                if geom is not None:
                    yield "relation", rid, tags, geom

    def iter_lines(self, predicate):
        for wid, way in self.ways.items():
            tags = way["tags"]
            if tags and predicate(tags):
                pts = self.way_coords(wid)
                if pts:
                    yield wid, tags, pts

    def iter_points(self, predicate):
        for nid, tags in self.node_tags.items():
            if predicate(tags):
                ll = self.nodes.get(nid)
                if ll:
                    yield nid, tags, lonlat_to_xz(*ll), ll

    def sea_polygon(self, bbox_scene):
        """Polygonise natural=coastline ways against the scene bbox.  Water is
        on the right-hand side of a coastline way."""
        lines = [LineString(pts) for _, _, pts in self.iter_lines(lambda t: t.get("natural") == "coastline")]
        if not lines:
            return None
        x0, z0, x1, z1 = bbox_scene
        box = Polygon([(x0, z0), (x1, z0), (x1, z1), (x0, z1)])
        merged = linemerge(unary_union(lines))
        coast = [g for g in getattr(merged, "geoms", [merged])]
        pieces = list(polygonize(unary_union([box.exterior] + [c.intersection(box) for c in coast])))
        sea = []
        for piece in pieces:
            rp = piece.representative_point()
            best, best_d = None, 1e18
            for c in coast:
                d = c.distance(rp)
                if d < best_d:
                    best, best_d = c, d
            if best is None:
                continue
            s = best.project(rp)
            p0 = best.interpolate(max(0.0, s - 5.0))
            p1 = best.interpolate(min(best.length, s + 5.0))
            dx, dz = p1.x - p0.x, p1.y - p0.y
            nearest = best.interpolate(s)
            rx, rz = rp.x - nearest.x, rp.y - nearest.y
            # Scene z points south, so the usual "right-hand" sign flips.
            cross = dx * rz - dz * rx
            if cross > 0:
                sea.append(piece)
        if not sea:
            return None
        return unary_union(sea)


_HEIGHT_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*(m|meters|metres)?\s*$", re.I)
_FEET_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(ft|feet|')", re.I)


def parse_length(value):
    if value is None:
        return None
    m = _HEIGHT_RE.match(value)
    if m:
        return float(m.group(1))
    m = _FEET_RE.match(value)
    if m:
        return float(m.group(1)) * 0.3048
    try:
        return float(value.replace(",", "."))
    except ValueError:
        return None


NAMED_COLOURS = {
    "white": (0.95, 0.94, 0.90), "beige": (0.92, 0.87, 0.76), "cream": (0.96, 0.93, 0.82),
    "grey": (0.66, 0.66, 0.64), "gray": (0.66, 0.66, 0.64), "lightgrey": (0.80, 0.80, 0.78),
    "yellow": (0.93, 0.85, 0.50), "brown": (0.55, 0.42, 0.30), "red": (0.72, 0.30, 0.25),
    "blue": (0.45, 0.60, 0.80), "lightblue": (0.70, 0.82, 0.92), "green": (0.50, 0.65, 0.45),
    "pink": (0.93, 0.78, 0.76), "orange": (0.90, 0.62, 0.35), "black": (0.15, 0.15, 0.15),
    "tan": (0.85, 0.75, 0.60), "sand": (0.88, 0.80, 0.64), "ochre": (0.82, 0.66, 0.40),
    "salmon": (0.93, 0.70, 0.60), "silver": (0.78, 0.78, 0.80), "darkgrey": (0.40, 0.40, 0.40),
    "maroon": (0.50, 0.20, 0.20), "terracotta": (0.80, 0.45, 0.32),
}


def parse_colour(value):
    if not value:
        return None
    v = value.strip().lower().replace(" ", "")
    if v.startswith("#"):
        h = v[1:]
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        if len(h) == 6:
            try:
                return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
            except ValueError:
                return None
    return NAMED_COLOURS.get(v.replace("light_", "light").replace("_", ""))
