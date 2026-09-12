import * as THREE from 'three';
import { fetchChunk } from './chunkformat.js';
import { TERRAIN_RES, CHUNK_ZOOM, sceneToChunk } from './geo.js';
import { ImageryLoader } from './imagery.js';
import { buildTerrainGeometry, sampleHeight } from './terrain.js';
import { createWallMaterial } from './facades.js';
import { createWaterMaterial } from './water.js';
import { TreeFactory } from './vegetation.js';

const DATA = '/data/tiles';
const GEOM_LOAD_DIST = 3600;
const GEOM_UNLOAD_DIST = 5200;
const MAX_CONCURRENT = 3;
const TREE_DIST = 1900;
const LOD_DIST = 14000; // far skyline layer ({key}.l.bin)
const MAX_LOD_CONCURRENT = 4;
const QUAD_ZOOM = CHUNK_ZOOM + 1; // imagery is managed per chunk quadrant

function distToBox(px, pz, b) {
  const dx = Math.max(b.x0 - px, 0, px - b.x1);
  const dz = Math.max(b.z0 - pz, 0, pz - b.z1);
  return Math.hypot(dx, dz);
}

// Imagery detail for a quadrant: zoom 15 + k.  k=3 is ~0.6 m/px.
function imageryLevel(d) {
  if (d < 900) return 3;
  if (d < 2600) return 2;
  if (d < 6500) return 1;
  return 0;
}

function terrainStep(d) {
  if (d < 2800) return 1;
  if (d < 6500) return 2;
  if (d < 12000) return 4;
  return 8;
}

function makeGlowTexture() {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.7)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

function makeAsphaltTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < size * size; i++) {
    const v = 150 + rnd() * 105;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // blotches
  for (let k = 0; k < 60; k++) {
    ctx.fillStyle = `rgba(${rnd() < 0.5 ? 0 : 255},${rnd() < 0.5 ? 0 : 255},${rnd() < 0.5 ? 0 : 255},0.06)`;
    ctx.beginPath();
    ctx.ellipse(rnd() * size, rnd() * size, 10 + rnd() * 40, 6 + rnd() * 30, rnd() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

class Quad {
  constructor(chunk, qi, qj) {
    this.chunk = chunk;
    this.qi = qi;
    this.qj = qj;
    const b = chunk.bounds;
    const mx = (b.x0 + b.x1) / 2;
    const mz = (b.z0 + b.z1) / 2;
    this.bounds = {
      x0: qi ? mx : b.x0, x1: qi ? b.x1 : mx,
      z0: qj ? mz : b.z0, z1: qj ? b.z1 : mz,
    };
    this.tx = chunk.meta.x * 2 + qi;
    this.ty = chunk.meta.y * 2 + qj;
    // Geometry carries chunk-relative UVs; map this quadrant's texture onto its sub-range.
    this.transform = { repeat: new THREE.Vector2(2, 2), offset: new THREE.Vector2(-qi, -(1 - qj)) };
    this.mesh = null;
    this.step = -1;
    this.k = -1;
    this.texture = null;
    this.roofMaterial = null;
    this.dist = Infinity;
  }
}

class Chunk {
  constructor(meta, heights) {
    this.meta = meta;
    this.key = meta.key;
    this.bounds = meta.bounds;
    this.heights = heights;
    this.quads = [new Quad(this, 0, 0), new Quad(this, 1, 0), new Quad(this, 0, 1), new Quad(this, 1, 1)];
    this.geom = null;
    this.water = null;
    this.lod = null;
    this.lodState = 'empty'; // empty | loading | ready | failed
    this.state = 'empty'; // empty | loading | ready | failed
    this.dist = Infinity;
  }
}

export class World {
  constructor(scene, renderer, shared, opts = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.shared = shared;
    this.opts = Object.assign({ roofImagery: true }, opts);
    this.imagery = new ImageryLoader(renderer);
    this.chunks = new Map();
    this.chunkList = [];
    this.trees = new TreeFactory();
    this.wallMaterial = createWallMaterial(shared.facadeAtlas, shared);
    this.roadMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    // World-space asphalt grain so long ribbons don't read as flat paint.
    const asphalt = makeAsphaltTexture();
    this.roadMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.asphaltMap = { value: asphalt };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec3 roadUv;
          attribute float roadMark;
          varying vec3 vRoadP;
          varying vec3 vRoadUv;
          varying float vRoadMark;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vRoadP = (modelMatrix * vec4(position, 1.0)).xyz;
          vRoadUv = roadUv;
          vRoadMark = roadMark;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D asphaltMap;
          varying vec3 vRoadP;
          varying vec3 vRoadUv;
          varying float vRoadMark;
          // anti-aliased band |x| < w (metres) given the screen-space footprint
          float band(float x, float w, float fw) { return 1.0 - smoothstep(w - fw, w + fw, abs(x)); }`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          float grain = texture2D(asphaltMap, vRoadP.xz / 9.0).r;
          float grain2 = texture2D(asphaltMap, vRoadP.xz / 1.7).r;
          diffuseColor.rgb *= 0.78 + 0.32 * grain + 0.12 * grain2;
          {
            float hw = vRoadUv.z;             // half width (m)
            float um = vRoadUv.x * hw;        // metres from the centre line
            float v = vRoadUv.y;              // metres along the way
            float fw = fwidth(um) * 0.8 + 0.01;
            float fv = fwidth(v) * 0.8 + 0.01;
            float mark = vRoadMark;
            // fade markings out with distance so they don't shimmer
            float fade = 1.0 - smoothstep(180.0, 420.0, length(vRoadP - cameraPosition));
            vec3 paint = vec3(0.85, 0.83, 0.76);
            if (mark > 0.5 && mark < 3.5) {
              // kerb: a lighter concrete strip along both edges, slightly worn
              float kerb = band(abs(um) - hw, 0.32, fw);
              float wear = 0.75 + 0.25 * grain;
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.58, 0.57, 0.54) * wear, kerb * 0.9);
            }
            if (mark > 1.5 && mark < 2.5) {
              // dashed centre line 3 m on / 3 m off
              float dash = step(0.5, fract(v / 6.0));
              float line = band(um, 0.07, fw) * dash * fade * (0.55 + 0.45 * grain);
              diffuseColor.rgb = mix(diffuseColor.rgb, paint, line);
            }
            if (mark > 2.5 && mark < 3.5) {
              // dual carriageway: solid edge lines, dashed lane lines every 3.5 m
              float edge = band(abs(um) - (hw - 0.55), 0.08, fw);
              float lanes = max(1.0, floor(hw * 2.0 / 3.5));
              float laneW = hw * 2.0 / lanes;
              float lu = mod(um + hw + laneW * 0.5, laneW) - laneW * 0.5;
              float inner = band(lu, 0.07, fw) * step(0.6, fract(v / 9.0));
              float notEdge = 1.0 - band(abs(um) - hw, 0.9, fw);
              float line = clamp(edge + inner * notEdge, 0.0, 1.0) * fade * (0.55 + 0.45 * grain);
              diffuseColor.rgb = mix(diffuseColor.rgb, paint, line);
            }
            if (mark > 3.5 && mark < 4.5) {
              // railway: ballast, sleepers every 0.7 m, two rails 1.435 m apart
              vec3 ballast = vec3(0.42, 0.39, 0.35) * (0.7 + 0.5 * grain2);
              float sleeper = step(0.55, fract(v / 0.7)) * band(um, 1.25, fw);
              vec3 col = mix(ballast, vec3(0.30, 0.25, 0.20), sleeper * fade);
              float rail = max(band(um - 0.72, 0.05, fw), band(um + 0.72, 0.05, fw));
              col = mix(col, vec3(0.55, 0.52, 0.48), rail * fade);
              diffuseColor.rgb = col;
            }
            if (mark > 4.5) {
              // runway: centre dashes and edge lines
              float line = (band(um, 0.45, fw) * step(0.5, fract(v / 60.0)) + band(abs(um) - (hw - 1.0), 0.45, fw)) * fade;
              diffuseColor.rgb = mix(diffuseColor.rgb, paint, clamp(line, 0.0, 1.0));
            }
          }`);
    };
    this.roadMaterial.customProgramCacheKey = () => 'tunis-road';
    this.lodMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    // Street lights: additive glow sprites along major roads, faded in with
    // nightFactor (Tunis is mostly sodium-orange).
    this.lampMaterial = new THREE.ShaderMaterial({
      uniforms: { nightFactor: shared.nightFactor, glow: { value: makeGlowTexture() } },
      vertexShader: `
        uniform float nightFactor;
        varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float d = -mv.z;
          gl_PointSize = clamp(2200.0 / d, 2.0, 26.0);
          vA = nightFactor * smoothstep(3000.0, 1200.0, d);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D glow;
        varying float vA;
        void main() {
          float a = texture2D(glow, gl_PointCoord).r * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(1.0, 0.72, 0.38) * a * 1.6, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.lodLoading = 0;
    this.waterMaterial = createWaterMaterial(shared);
    this.terrainFallback = new THREE.MeshStandardMaterial({ color: 0x9a9784, roughness: 1 });
    this.loading = 0;
    this.lastUpdate = -1;
    this.lastPos = new THREE.Vector3(1e9, 0, 0);
    this.terrainGroup = new THREE.Group();
    this.terrainGroup.name = 'terrain';
    this.geomGroup = new THREE.Group();
    this.geomGroup.name = 'geometry';
    this.waterGroup = new THREE.Group();
    this.waterGroup.name = 'water';
    scene.add(this.terrainGroup, this.geomGroup, this.waterGroup);
    this.stats = { chunksLoaded: 0, buildingsVerts: 0 };
    this.layers = { roads: true, trees: true };
  }

  async init(onProgress) {
    const [index, heightsBuf] = await Promise.all([
      fetch(`${DATA}/index.json`).then((r) => r.json()),
      fetch(`${DATA}/heights.bin`).then((r) => r.arrayBuffer()),
    ]);
    this.index = index;
    const n = (TERRAIN_RES + 1) * (TERRAIN_RES + 1);
    index.chunks.forEach((meta, i) => {
      const heights = new Float32Array(heightsBuf, i * n * 4, n);
      const c = new Chunk(meta, heights);
      this.chunks.set(`${meta.x}_${meta.y}`, c);
      this.chunkList.push(c);
    });
    let done = 0;
    await Promise.all(
      this.chunkList
        .filter((c) => c.meta.has_water)
        .map((c) =>
          fetchChunk(`${DATA}/${c.key}.w.bin`)
            .then((data) => this.addWater(c, data))
            .catch(() => {})
            .finally(() => onProgress && onProgress(++done)),
        ),
    );
  }

  addWater(chunk, data) {
    const s = data.sections;
    if (!s.water_pos) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(s.water_pos, 3));
    g.setIndex(new THREE.BufferAttribute(s.water_idx, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.waterMaterial);
    mesh.renderOrder = 2;
    chunk.water = mesh;
    this.waterGroup.add(mesh);
  }

  heightAt(x, z) {
    const [tx, ty] = sceneToChunk(x, z);
    const c = this.chunks.get(`${tx}_${ty}`);
    if (!c) return 0;
    return sampleHeight(c.heights, c.bounds, x, z);
  }

  // ---- per-frame ---------------------------------------------------------
  update(camera, time) {
    this.waterMaterial.uniforms.time.value = time;
    this.waterMaterial.uniforms.cameraPos.value.copy(camera.position);
    this.waterMaterial.uniforms.fogColor.value.copy(this.scene.fog.color);
    this.waterMaterial.uniforms.fogDensity.value = this.scene.fog.density;
    const moved = camera.position.distanceTo(this.lastPos);
    if (time - this.lastUpdate < 0.4 && moved < 100) return;
    this.lastUpdate = time;
    this.lastPos.copy(camera.position);
    const px = camera.position.x;
    const pz = camera.position.z;
    const alt = camera.position.y - this.heightAt(px, pz);
    // Higher up, less detail is needed nearby but more chunks are visible.
    const detailScale = THREE.MathUtils.clamp(1 + alt / 1200, 1, 4);

    let hiRes = 0;
    for (const c of this.chunkList) {
      c.dist = distToBox(px, pz, c.bounds);
      for (const q of c.quads) {
        q.dist = distToBox(px, pz, q.bounds);
        const d = q.dist * detailScale;
        const step = terrainStep(d);
        if (step !== q.step) this.buildTerrain(q, step);
        let k = imageryLevel(d);
        if (k === 3 && ++hiRes > 12) k = 2;
        if (k !== q.k) this.setImagery(q, k);
      }
    }
    const wanted = this.chunkList
      .filter((c) => c.dist < GEOM_LOAD_DIST && c.meta.bytes > 0)
      .sort((a, b) => a.dist - b.dist);
    for (const c of wanted) {
      if (c.state === 'empty' && this.loading < MAX_CONCURRENT) this.loadGeometry(c);
    }
    for (const c of this.chunkList) {
      if (c.state === 'ready' && c.dist > GEOM_UNLOAD_DIST) this.unloadGeometry(c);
      if (c.trees) c.trees.visible = this.layers.trees && c.dist < TREE_DIST * (alt > 800 ? 0.6 : 1);
      // far skyline: shown wherever the full geometry isn't resident
      if (c.meta.lod_bytes > 0 && c.dist < LOD_DIST) {
        if (c.lodState === 'empty' && this.lodLoading < MAX_LOD_CONCURRENT) this.loadLod(c);
        if (c.lod) c.lod.visible = c.state !== 'ready';
      } else if (c.lod) {
        c.lod.visible = false;
      }
    }
  }

  // ---- terrain -------------------------------------------------------------
  buildTerrain(q, step) {
    const geo = buildTerrainGeometry(q.chunk.heights, q.chunk.bounds, step, q.qi, q.qj);
    if (q.mesh) {
      q.mesh.geometry.dispose();
      q.mesh.geometry = geo;
    } else {
      const mat = this.terrainFallback.clone();
      q.mesh = new THREE.Mesh(geo, mat);
      q.mesh.receiveShadow = true;
      q.mesh.name = `terrain_${q.chunk.key}_${q.qi}${q.qj}`;
      this.terrainGroup.add(q.mesh);
    }
    q.step = step;
  }

  setImagery(q, k) {
    const prevK = q.k;
    q.k = k;
    this.imagery.get(QUAD_ZOOM, q.tx, q.ty, k, q.transform).then((tex) => {
      if (q.k !== k) return; // superseded
      q.texture = tex;
      const mat = q.mesh.material;
      mat.map = tex;
      mat.color.set(0xffffff);
      mat.needsUpdate = true;
      if (q.roofMaterial && this.opts.roofImagery) {
        q.roofMaterial.map = tex;
        q.roofMaterial.needsUpdate = true;
      }
      if (prevK >= 0 && prevK !== k) this.imagery.release(QUAD_ZOOM, q.tx, q.ty, prevK);
    });
  }

  // ---- geometry ------------------------------------------------------------
  async loadGeometry(c) {
    c.state = 'loading';
    this.loading++;
    try {
      const data = await fetchChunk(`${DATA}/${c.key}.bin`);
      if (c.state !== 'loading') return;
      c.geom = this.buildGeometry(c, data);
      this.geomGroup.add(c.geom);
      c.state = 'ready';
      this.stats.chunksLoaded++;
    } catch (err) {
      console.warn('chunk failed', c.key, err);
      c.state = 'failed';
    } finally {
      this.loading--;
    }
  }

  async loadLod(c) {
    c.lodState = 'loading';
    this.lodLoading++;
    try {
      const data = await fetchChunk(`${DATA}/${c.key}.l.bin`);
      const s = data.sections;
      if (!s.lod_pos) throw new Error('empty lod');
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(s.lod_pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(s.lod_col, 3, true));
      g.setIndex(new THREE.BufferAttribute(s.lod_idx, 1));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, this.lodMaterial);
      mesh.name = `lod_${c.key}`;
      mesh.visible = c.state !== 'ready';
      c.lod = mesh;
      this.geomGroup.add(mesh);
      c.lodState = 'ready';
    } catch (err) {
      c.lodState = 'failed';
    } finally {
      this.lodLoading--;
    }
  }

  unloadGeometry(c) {
    c.trees = null;
    if (c.geom) {
      this.geomGroup.remove(c.geom);
      c.geom.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
      for (const q of c.quads) {
        if (q.roofMaterial) q.roofMaterial.dispose();
        q.roofMaterial = null;
      }
      c.geom = null;
    }
    c.state = 'empty';
    this.stats.chunksLoaded--;
  }

  buildGeometry(c, data) {
    const s = data.sections;
    const group = new THREE.Group();
    group.name = `geom_${c.key}`;
    const b = c.bounds;

    if (s.wall_pos) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(s.wall_pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(s.wall_col, 3, true));
      g.setAttribute('uv', new THREE.BufferAttribute(s.wall_uv, 2));
      g.setAttribute('style', new THREE.BufferAttribute(s.wall_style, 1, false));
      g.setIndex(new THREE.BufferAttribute(s.wall_idx, 1));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const walls = new THREE.Mesh(g, this.wallMaterial);
      walls.castShadow = true;
      walls.receiveShadow = true;
      walls.name = 'walls';
      group.add(walls);
      this.stats.buildingsVerts += s.wall_pos.length / 3;
    }
    if (s.roof_pos) {
      // Roofs are split per quadrant so each can sample its quadrant's imagery.
      const pos = s.roof_pos;
      const n = pos.length / 3;
      const uv = new Float32Array(n * 2);
      const w = b.x1 - b.x0;
      const h = b.z1 - b.z0;
      for (let i = 0; i < n; i++) {
        uv[i * 2] = (pos[i * 3] - b.x0) / w;
        uv[i * 2 + 1] = 1 - (pos[i * 3 + 2] - b.z0) / h;
      }
      const posAttr = new THREE.BufferAttribute(pos, 3);
      const colAttr = new THREE.BufferAttribute(s.roof_col, 3, true);
      const uvAttr = new THREE.BufferAttribute(uv, 2);
      const idx = s.roof_idx;
      const buckets = [[], [], [], []];
      const mx = (b.x0 + b.x1) / 2;
      const mz = (b.z0 + b.z1) / 2;
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t];
        const qi = pos[a * 3] >= mx ? 1 : 0;
        const qj = pos[a * 3 + 2] >= mz ? 1 : 0;
        buckets[qj * 2 + qi].push(idx[t], idx[t + 1], idx[t + 2]);
      }
      c.quads.forEach((q, qidx) => {
        const list = buckets[qidx];
        if (!list.length) return;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', posAttr);
        g.setAttribute('color', colAttr);
        g.setAttribute('uv', uvAttr);
        g.setIndex(new THREE.BufferAttribute(new Uint32Array(list), 1));
        g.computeVertexNormals();
        g.computeBoundingSphere();
        q.roofMaterial = new THREE.MeshStandardMaterial({
          vertexColors: !this.opts.roofImagery,
          map: this.opts.roofImagery ? q.texture : null,
          roughness: 0.9,
          metalness: 0,
        });
        const roofs = new THREE.Mesh(g, q.roofMaterial);
        roofs.castShadow = true;
        roofs.receiveShadow = true;
        roofs.name = 'roofs';
        group.add(roofs);
      });
    }
    if (s.road_pos) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(s.road_pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(s.road_col, 3, true));
      if (s.road_uv && s.road_style) {
        g.setAttribute('roadUv', new THREE.BufferAttribute(s.road_uv, 3));
        g.setAttribute('roadMark', new THREE.BufferAttribute(s.road_style, 1));
      } else {
        // older tiles without markings: zero attributes keep the shader happy
        const n = s.road_pos.length / 3;
        g.setAttribute('roadUv', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        g.setAttribute('roadMark', new THREE.BufferAttribute(new Uint8Array(n), 1));
      }
      g.setIndex(new THREE.BufferAttribute(s.road_idx, 1));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const roads = new THREE.Mesh(g, this.roadMaterial);
      roads.receiveShadow = true;
      roads.name = 'roads';
      group.add(roads);
      if (s.road_uv && s.road_style) {
        // one lamp every ~36 m on the right-hand edge of marked roads
        const lp = [];
        const n = s.road_pos.length / 3;
        // vertices come in a,b,c,d quads per segment; c is the right-hand
        // vertex at the segment end, so taking only it avoids duplicates
        for (let i = 2; i < n; i += 4) {
          const mark = s.road_style[i];
          if (mark < 1 || mark > 3) continue;
          const v = s.road_uv[i * 3 + 1];
          const period = mark === 1 ? 40 : 30;
          if (v % period > 12.5) continue;
          lp.push(s.road_pos[i * 3], s.road_pos[i * 3 + 1] + 7.5, s.road_pos[i * 3 + 2]);
        }
        if (lp.length) {
          const lg = new THREE.BufferGeometry();
          lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
          lg.computeBoundingSphere();
          const lamps = new THREE.Points(lg, this.lampMaterial);
          lamps.name = 'lamps';
          lamps.frustumCulled = true;
          lamps.renderOrder = 3;
          group.add(lamps);
        }
      }
    }
    if (s.tree_pos) {
      const trees = this.trees.build(s.tree_pos, s.tree_type, s.tree_h);
      trees.name = 'trees';
      trees.visible = c.dist < TREE_DIST;
      c.trees = trees;
      group.add(trees);
    }
    return group;
  }

  setRoofImagery(on) {
    this.opts.roofImagery = on;
    for (const c of this.chunkList) {
      for (const q of c.quads) {
        if (q.roofMaterial) {
          q.roofMaterial.map = on ? q.texture : null;
          q.roofMaterial.vertexColors = !on;
          q.roofMaterial.needsUpdate = true;
        }
      }
    }
  }

  setLayerVisible(name, on) {
    this.layers[name] = on;
    this.geomGroup.traverse((o) => {
      if (o.name === name) o.visible = on;
    });
    if (name === 'water') this.waterGroup.visible = on;
  }
}
