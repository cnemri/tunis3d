"""Extract Greater Tunis from the Geofabrik Tunisia PBF into Overpass-style
JSON (data/raw/osm_pbf/tunis.json) so the rest of the pipeline is unchanged.

Two passes: the first collects member ways of relevant relations, the second
emits tagged ways / nodes / relations inside the bounding box together with
every node they reference.
"""
import json
import os
import sys
import time

import osmium

from config import BBOX, RAW_DIR

PBF = os.path.join(RAW_DIR, "tunisia-latest.osm.pbf")
OUT_DIR = os.path.join(RAW_DIR, "osm_pbf")
MARGIN = 0.01  # degrees; keep features slightly outside so chunk edges are complete

WAY_KEYS = ("building", "building:part", "highway", "railway", "aeroway", "man_made", "barrier",
            "natural", "landuse", "leisure", "waterway", "amenity", "place", "historic", "tourism",
            "power", "sport")
REL_KEYS = ("building", "building:part", "natural", "landuse", "leisure", "waterway", "amenity",
            "aeroway", "place", "historic", "tourism", "man_made", "sport")
NODE_KEYS = ("natural", "man_made", "historic", "tourism", "amenity", "place", "public_transport",
             "railway", "highway", "power")


def in_bbox(lon, lat):
    w, s, e, n = BBOX
    return (w - MARGIN) <= lon <= (e + MARGIN) and (s - MARGIN) <= lat <= (n + MARGIN)


class RelationScan(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.member_ways = set()
        self.relations = {}

    def relation(self, r):
        tags = dict(r.tags)
        rtype = tags.get("type")
        if rtype not in ("multipolygon", "building", "site"):
            return
        if not any(k in tags for k in REL_KEYS):
            return
        members = [(m.type, m.ref, m.role) for m in r.members]
        self.relations[r.id] = {"tags": tags, "members": members}
        for t, ref, _ in members:
            if t == "w":
                self.member_ways.add(ref)


class Extract(osmium.SimpleHandler):
    def __init__(self, member_ways):
        super().__init__()
        self.member_ways = member_ways
        self.nodes = {}
        self.node_tags = {}
        self.ways = {}
        self.ways_seen = set()
        self.n_nodes = 0

    def node(self, n):
        self.n_nodes += 1
        if len(n.tags) == 0:
            return
        if not n.location.valid():
            return
        lon, lat = n.location.lon, n.location.lat
        if not in_bbox(lon, lat):
            return
        tags = dict(n.tags)
        if any(k in tags for k in NODE_KEYS):
            self.nodes[n.id] = (lon, lat)
            self.node_tags[n.id] = tags

    def way(self, w):
        tags = dict(w.tags)
        relevant = any(k in tags for k in WAY_KEYS) or w.id in self.member_ways
        if not relevant:
            return
        coords = []
        inside = False
        for nd in w.nodes:
            if not nd.location.valid():
                continue
            lon, lat = nd.location.lon, nd.location.lat
            coords.append((nd.ref, lon, lat))
            if not inside and in_bbox(lon, lat):
                inside = True
        if not inside or len(coords) < 2:
            return
        for ref, lon, lat in coords:
            self.nodes[ref] = (lon, lat)
        self.ways[w.id] = {"nodes": [c[0] for c in coords], "tags": tags}


def main():
    if not os.path.exists(PBF):
        sys.exit(f"missing {PBF}")
    os.makedirs(OUT_DIR, exist_ok=True)
    t0 = time.time()
    print("pass 1: relations", flush=True)
    scan = RelationScan()
    scan.apply_file(PBF)
    print(f"  {len(scan.relations)} candidate relations, {len(scan.member_ways)} member ways ({time.time() - t0:.0f}s)")

    print("pass 2: ways and nodes", flush=True)
    ex = Extract(scan.member_ways)
    ex.apply_file(PBF, locations=True, idx="flex_mem")
    print(f"  {ex.n_nodes} nodes scanned, {len(ex.ways)} ways kept, {len(ex.nodes)} nodes kept ({time.time() - t0:.0f}s)")

    # Relations: keep those with at least one kept way member.
    elements = []
    for nid, (lon, lat) in ex.nodes.items():
        el = {"type": "node", "id": nid, "lon": lon, "lat": lat}
        if nid in ex.node_tags:
            el["tags"] = ex.node_tags[nid]
        elements.append(el)
    for wid, w in ex.ways.items():
        elements.append({"type": "way", "id": wid, "nodes": w["nodes"], "tags": w["tags"]})
    n_rel = 0
    for rid, r in scan.relations.items():
        members = [{"type": {"w": "way", "n": "node", "r": "relation"}[t], "ref": ref, "role": role}
                   for t, ref, role in r["members"]]
        if any(m["type"] == "way" and m["ref"] in ex.ways for m in members):
            elements.append({"type": "relation", "id": rid, "members": members, "tags": r["tags"]})
            n_rel += 1
    out = os.path.join(OUT_DIR, "tunis.json")
    with open(out, "w") as f:
        json.dump({"elements": elements}, f)
    print(f"wrote {out}: {len(ex.nodes)} nodes, {len(ex.ways)} ways, {n_rel} relations "
          f"({os.path.getsize(out) / 1e6:.0f} MB, {time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
