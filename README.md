# Tunis 3D

A navigable, data-faithful 3D model of Greater Tunis (Medina, Ville Nouvelle, Bardo,
Ariana, Lac de Tunis, La Goulette, Carthage, Sidi Bou Saïd, La Marsa, Radès) built
from open geodata and rendered in the browser with three.js.

Everything in the scene comes from real data:

| Layer | Source |
|---|---|
| Terrain | SRTM-derived AWS Terrain Tiles (Terrarium, z14), smoothed and flattened under water |
| Buildings | OpenStreetMap footprints/heights/levels, gap-filled with Google Open Buildings v3 (~578k buildings) |
| Roads, rail, bridges, water, coastline, land use | OpenStreetMap (Geofabrik Tunisia extract) |
| Ground and roof imagery | Esri World Imagery, streamed at z15–z18 by distance |
| Trees | ~1.2M crowns detected from imagery, species by OSM land cover, plus OSM `natural=tree` |
| Monuments | 33 curated landmarks (Zitouna, Bab el Bhar, Hôtel du Lac, Hôtel Africa, Cathedral, Bardo, Carthage, Sidi Bou Saïd lighthouse, Radès and El Menzah stadium bowls…) matched to OSM geometry and modelled procedurally |
| Night | window lights from the facade masks, sodium street lamps along marked roads, time-of-day sky |

## Quick start

```sh
npm install
python3 -m venv .venv && ./.venv/bin/pip install numpy pillow shapely pyproj mapbox_earcut requests scipy s2sphere osmium
npm run pipeline        # downloads ~1 GB of source data, builds data/tiles (see below)
npm run dev             # http://127.0.0.1:5180
```

The scene frame is metres: x east, y up (ASL), z south, origin at Bab el Bhar
(10.1760 E, 36.7995 N). Chunks are zoom‑14 slippy tiles (~1.96 km) streamed on demand.

## Controls

- `W A S D` move, `Space` / `C` up / down, `Shift` fast
- Click to look around, `Esc` to release the mouse
- `F` toggles fly / walk (walk mode keeps you 1.7 m above the terrain)
- "Go to" landmark menu, time-of-day slider, toggles for satellite roofs / roads / trees / shadows
- URL hash sets the start pose: `#lat,lon[,alt[,heading[,pitch]]]`, e.g. `#36.79965,10.1815,1.7,88,4`

## Pipeline

`pipeline/run_all.py` runs the steps below in order and skips outputs that already exist
(`--force` rebuilds everything, `--skip-imagery` / `--skip-trees` for a quick first build):

1. `fetch_terrain.py` – Terrarium DEM tiles → `data/terrain/dem.npy`
2. Geofabrik `tunisia-latest.osm.pbf` → `data/raw/`
3. `extract_osm.py` – pyosmium extract of the bbox → `data/raw/osm_pbf/tunis.json`
4. `fetch_open_buildings.py` – Open Buildings S2 cells `12fd`, `12e3` (confidence ≥ 0.65) → `data/raw/open_buildings.csv`
5. `fetch_imagery.py 15 16 17` – Esri tiles cached to `data/imagery/{z}/{x}/{y}.jpg` (z18 is fetched live by the client)
6. `detect_trees.py` – excess-green crown detection on z17 imagery → `data/raw/detected_trees.csv`
7. `build_tiles.py` – terrain grids, extruded buildings with facade styles, draped roads and bridges,
   water, trees, landmark features → `data/tiles/*.bin`, `data/tiles/heights.bin`, `data/landmarks.json`

Chunk files use a small binary container (`TUN1` magic, JSON header, 4-byte aligned sections);
`web/src/chunkformat.js` is the reader. Per chunk: `{key}.bin` (walls with facade style and
metre UVs, roofs, road ribbons with cross/along UVs and a marking class, trees), `{key}.w.bin`
(water, loaded up front) and `{key}.l.bin` (far-skyline LOD: prominent buildings only, flat
colours, streamed out to 14 km).

## Repository layout

- `pipeline/` – Python data pipeline (`config.py` holds the bbox, origin and URLs)
- `web/` – Vite + three.js client (`world.js` streaming, `terrain.js`, `imagery.js`, `facades.js`,
  `landmarks.js`, `vegetation.js`, `water.js`, `sky.js`, `controls.js`, `ui.js`)
- `tools/shot.mjs` – headless screenshot helper: `node tools/shot.mjs out.jpg [lat,lon,alt,heading,pitch | landmarkId | overview] [hour]`
  (`PICK=x,y` raycasts a pixel); `tools/probe.mjs` dumps wall vertices near a scene point; `tools/atlas_dump.mjs` writes a facade atlas layer to PNG
- `data/` – generated data (not committed)

## Attribution

Map data © OpenStreetMap contributors (ODbL). Imagery: Esri World Imagery (Esri, Maxar,
Earthstar Geographics and the GIS User Community). Terrain: AWS Terrain Tiles / SRTM.
Building footprints: Google Open Buildings v3 (CC BY 4.0 / ODbL).
