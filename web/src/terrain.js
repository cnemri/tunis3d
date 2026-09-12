import * as THREE from 'three';
import { TERRAIN_RES } from './geo.js';

const SKIRT_DEPTH = 40;

// Build an indexed terrain mesh for one quadrant (qi, qj in 0..1) of a chunk's
// (RES+1)^2 height grid.  `step` decimates the grid (1 = full, 2 = half ...).
// UVs are chunk-relative (0..1 across the whole chunk, v = 1 at the north
// edge) so that quadrant textures can be applied with a texture transform.
// A skirt hangs from the edges so cracks between neighbouring LODs never show.
export function buildTerrainGeometry(heights, bounds, step = 1, qi = 0, qj = 0) {
  const res = TERRAIN_RES;
  const half = res / 2;
  const n = half / step;
  const stride = res + 1;
  const { x0, z0, x1, z1 } = bounds;
  const dx = (x1 - x0) / res;
  const dz = (z1 - z0) / res;
  const gi0 = qi * half;
  const gj0 = qj * half;

  const inner = (n + 1) * (n + 1);
  const skirt = 4 * (n + 1);
  const count = inner + skirt;
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);

  let p = 0;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const gi = gi0 + i * step;
      const gj = gj0 + j * step;
      pos[p * 3] = x0 + gi * dx;
      pos[p * 3 + 1] = heights[gj * stride + gi];
      pos[p * 3 + 2] = z0 + gj * dz;
      uv[p * 2] = gi / res;
      uv[p * 2 + 1] = 1 - gj / res;
      p++;
    }
  }
  const edgeIndex = (side, k) => {
    // side 0: north (j=0), 1: south (j=n), 2: west (i=0), 3: east (i=n)
    if (side === 0) return k;
    if (side === 1) return n * (n + 1) + k;
    if (side === 2) return k * (n + 1);
    return k * (n + 1) + n;
  };
  for (let side = 0; side < 4; side++) {
    for (let k = 0; k <= n; k++) {
      const src = edgeIndex(side, k);
      pos[p * 3] = pos[src * 3];
      pos[p * 3 + 1] = pos[src * 3 + 1] - SKIRT_DEPTH;
      pos[p * 3 + 2] = pos[src * 3 + 2];
      uv[p * 2] = uv[src * 2];
      uv[p * 2 + 1] = uv[src * 2 + 1];
      p++;
    }
  }

  const tris = n * n * 2 + 4 * n * 2;
  const idx = new Uint32Array(tris * 3);
  let q = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + (n + 1);
      const d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b;
      idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
  }
  for (let side = 0; side < 4; side++) {
    for (let k = 0; k < n; k++) {
      const e0 = edgeIndex(side, k);
      const e1 = edgeIndex(side, k + 1);
      const s0 = inner + side * (n + 1) + k;
      const s1 = s0 + 1;
      if (side === 0 || side === 3) {
        idx[q++] = e0; idx[q++] = e1; idx[q++] = s0;
        idx[q++] = e1; idx[q++] = s1; idx[q++] = s0;
      } else {
        idx[q++] = e0; idx[q++] = s0; idx[q++] = e1;
        idx[q++] = e1; idx[q++] = s0; idx[q++] = s1;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  // Normals from the full-resolution grid (central differences) so lighting
  // does not change when the LOD changes.
  const nrm = new Float32Array(count * 3);
  p = 0;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const gi = gi0 + i * step;
      const gj = gj0 + j * step;
      const il = Math.max(0, gi - 1), ir = Math.min(res, gi + 1);
      const jl = Math.max(0, gj - 1), jr = Math.min(res, gj + 1);
      const hx = (heights[gj * stride + ir] - heights[gj * stride + il]) / ((ir - il) * dx);
      const hz = (heights[jr * stride + gi] - heights[jl * stride + gi]) / ((jr - jl) * dz);
      const l = Math.hypot(hx, 1, hz);
      nrm[p * 3] = -hx / l;
      nrm[p * 3 + 1] = 1 / l;
      nrm[p * 3 + 2] = -hz / l;
      p++;
    }
  }
  for (let side = 0; side < 4; side++) {
    for (let k = 0; k <= n; k++) {
      const src = edgeIndex(side, k);
      const dst = inner + side * (n + 1) + k;
      nrm[dst * 3] = nrm[src * 3];
      nrm[dst * 3 + 1] = nrm[src * 3 + 1];
      nrm[dst * 3 + 2] = nrm[src * 3 + 2];
    }
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

// Bilinear height lookup inside one chunk's grid.
export function sampleHeight(heights, bounds, x, z) {
  const res = TERRAIN_RES;
  const stride = res + 1;
  const fx = ((x - bounds.x0) / (bounds.x1 - bounds.x0)) * res;
  const fz = ((z - bounds.z0) / (bounds.z1 - bounds.z0)) * res;
  const i = Math.max(0, Math.min(res - 1, Math.floor(fx)));
  const j = Math.max(0, Math.min(res - 1, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - i));
  const tz = Math.max(0, Math.min(1, fz - j));
  const h00 = heights[j * stride + i];
  const h10 = heights[j * stride + i + 1];
  const h01 = heights[(j + 1) * stride + i];
  const h11 = heights[(j + 1) * stride + i + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}
