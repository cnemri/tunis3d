// Scene frame: x = east (m), y = up (m ASL), z = south (m).
// Mirrors pipeline/geo.py - both sides must agree exactly.
export const ORIGIN_LON = 10.1760;
export const ORIGIN_LAT = 36.7995;
export const CHUNK_ZOOM = 14;
export const TERRAIN_RES = 128;

const EARTH_R = 6378137.0;
const DEG = Math.PI / 180;
const COS0 = Math.cos(ORIGIN_LAT * DEG);

export function lonLatToXZ(lon, lat) {
  return [
    (lon - ORIGIN_LON) * DEG * EARTH_R * COS0,
    -(lat - ORIGIN_LAT) * DEG * EARTH_R,
  ];
}

export function xzToLonLat(x, z) {
  return [
    ORIGIN_LON + x / (EARTH_R * COS0) / DEG,
    ORIGIN_LAT - z / EARTH_R / DEG,
  ];
}

export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const latR = lat * DEG;
  return [
    ((lon + 180) / 360) * n,
    ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n,
  ];
}

export function tileToLonLat(x, y, z) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lon, lat];
}

// Scene-space corners of a slippy tile: returns {x0, z0, x1, z1} where x0<x1, z0<z1.
export function tileSceneBounds(x, y, z) {
  const [w, n] = tileToLonLat(x, y, z);
  const [e, s] = tileToLonLat(x + 1, y + 1, z);
  const [x0, z0] = lonLatToXZ(w, n);
  const [x1, z1] = lonLatToXZ(e, s);
  return { x0, z0, x1, z1 };
}

export function chunkKey(x, y) {
  return `${CHUNK_ZOOM}_${x}_${y}`;
}

export function sceneToChunk(x, z) {
  const [lon, lat] = xzToLonLat(x, z);
  const [tx, ty] = lonLatToTile(lon, lat, CHUNK_ZOOM);
  return [Math.floor(tx), Math.floor(ty)];
}
