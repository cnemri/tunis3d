"""Shared configuration for the Tunis 3D data pipeline.

Coverage: Greater Tunis - the Medina and Ville Nouvelle, Bardo, Ariana, the
Lac de Tunis, La Goulette, Carthage, Sidi Bou Said, La Marsa, Rades and the
foot of Jebel Boukornine.
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
RAW_DIR = os.path.join(DATA_DIR, "raw")
TILE_DIR = os.path.join(DATA_DIR, "tiles")
TERRAIN_DIR = os.path.join(DATA_DIR, "terrain")
IMAGERY_DIR = os.path.join(DATA_DIR, "imagery")

# Bounding box (WGS84): west, south, east, north
BBOX = (10.06, 36.70, 10.38, 36.92)

# Local scene origin: Place de la Victoire / Bab el Bhar, the hinge between the
# Medina and Avenue Habib Bourguiba.
ORIGIN_LON = 10.1760
ORIGIN_LAT = 36.7995

# Slippy-map zoom used for terrain / geometry chunks (about 1.96 km per tile).
CHUNK_ZOOM = 14
# Terrain grid samples per chunk edge (vertices = TERRAIN_RES + 1).
TERRAIN_RES = 128

# Overpass endpoints, tried in order.
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
# Size of the cells the Overpass download is split into (degrees).
OVERPASS_CELL = 0.04

TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
IMAGERY_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
