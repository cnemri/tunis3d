import * as THREE from 'three';
import { mergeGeometries as _merge } from 'three/addons/utils/BufferGeometryUtils.js';

// Merge helper tolerant of mixed indexed / non-indexed inputs (Extrude vs Box).
function mergeGeometries(list) {
  const norm = list.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(n.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) n.deleteAttribute(name);
    }
    if (!n.attributes.uv) n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2));
    if (!n.attributes.normal) n.computeVertexNormals();
    return n;
  });
  return _merge(norm, false);
}

// Bespoke geometry for Tunis monuments and the generic "decorations" that make
// the skyline recognisable: minarets, domes, towers, city walls, aqueducts.
// Positions and footprints come from data/landmarks.json (pipeline output).

const MAT = {
  white: new THREE.MeshStandardMaterial({ color: 0xf3f0e7, roughness: 0.85 }),
  ochre: new THREE.MeshStandardMaterial({ color: 0xe3d2ad, roughness: 0.9 }),
  stone: new THREE.MeshStandardMaterial({ color: 0xcdbfa3, roughness: 0.95 }),
  greenTile: new THREE.MeshStandardMaterial({ color: 0x2d7a5a, roughness: 0.4, metalness: 0.1 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xd9b24a, roughness: 0.35, metalness: 0.7 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x9d9384, roughness: 0.9 }),
  darkGlass: new THREE.MeshStandardMaterial({ color: 0x2c3e50, roughness: 0.25, metalness: 0.6 }),
  redWhite: new THREE.MeshStandardMaterial({ color: 0xd94d3a, roughness: 0.7 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x8c9096, roughness: 0.5, metalness: 0.8 }),
  brick: new THREE.MeshStandardMaterial({ color: 0x9a6a50, roughness: 0.95 }),
  roman: new THREE.MeshStandardMaterial({ color: 0xc9b89a, roughness: 1.0 }),
  clockFace: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 0.4 }),
};

function footprintInfo(fp) {
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity, cx = 0, cz = 0;
  for (const [x, z] of fp) {
    minx = Math.min(minx, x); maxx = Math.max(maxx, x);
    minz = Math.min(minz, z); maxz = Math.max(maxz, z);
    cx += x; cz += z;
  }
  cx /= fp.length; cz /= fp.length;
  // Dominant edge direction (longest edge) for orientation.
  let best = 0, ang = 0;
  for (let i = 0; i < fp.length; i++) {
    const a = fp[i], b = fp[(i + 1) % fp.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > best) { best = l; ang = Math.atan2(b[1] - a[1], b[0] - a[0]); }
  }
  return { minx, maxx, minz, maxz, cx, cz, w: maxx - minx, h: maxz - minz, angle: ang };
}

function cornerNearest(fp, tx, tz) {
  let best = null, bd = Infinity;
  for (const p of fp) {
    const d = Math.hypot(p[0] - tx, p[1] - tz);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// ---- unit geometries (height 1, width 1) --------------------------------------
function squareMinaretGeo() {
  const parts = [];
  const shaft = new THREE.BoxGeometry(1, 0.78, 1); shaft.translate(0, 0.39, 0); parts.push(shaft);
  const slab = new THREE.BoxGeometry(1.3, 0.015, 1.3); slab.translate(0, 0.785, 0); parts.push(slab);
  const rail = new THREE.BoxGeometry(1.3, 0.03, 1.3); rail.translate(0, 0.81, 0); parts.push(rail);
  const lantern = new THREE.BoxGeometry(0.58, 0.16, 0.58); lantern.translate(0, 0.87, 0); parts.push(lantern);
  const g = mergeGeometries(parts);
  return g;
}
function squareMinaretRoofGeo() {
  const roof = new THREE.ConeGeometry(0.5, 0.06, 4); roof.rotateY(Math.PI / 4); roof.translate(0, 0.98, 0);
  const finial = new THREE.CylinderGeometry(0.01, 0.01, 0.06, 6); finial.translate(0, 1.02, 0);
  const balls = [0.0, 0.025, 0.05].map((y, i) => { const s = new THREE.SphereGeometry(0.04 - i * 0.008, 8, 6); s.translate(0, 1.0 + y, 0); return s; });
  return mergeGeometries([roof, finial, ...balls]);
}
function octMinaretGeo() {
  const shaft = new THREE.CylinderGeometry(0.5, 0.5, 0.76, 8); shaft.translate(0, 0.38, 0);
  const slab = new THREE.CylinderGeometry(0.68, 0.55, 0.03, 8); slab.translate(0, 0.775, 0);
  const rail = new THREE.CylinderGeometry(0.68, 0.68, 0.035, 8); rail.translate(0, 0.81, 0);
  const upper = new THREE.CylinderGeometry(0.36, 0.36, 0.11, 8); upper.translate(0, 0.865, 0);
  return mergeGeometries([shaft, slab, rail, upper]);
}
function octMinaretRoofGeo() {
  const roof = new THREE.ConeGeometry(0.46, 0.13, 8); roof.translate(0, 0.985, 0);
  const finial = new THREE.CylinderGeometry(0.012, 0.012, 0.07, 6); finial.translate(0, 1.06, 0);
  return mergeGeometries([roof, finial]);
}
function domeGeo() {
  const drum = new THREE.CylinderGeometry(1.0, 1.0, 0.18, 24); drum.translate(0, 0.09, 0);
  const dome = new THREE.SphereGeometry(1.0, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2); dome.scale(1, 0.92, 1); dome.translate(0, 0.18, 0);
  return mergeGeometries([drum, dome]);
}
function finialGeo() {
  const rod = new THREE.CylinderGeometry(0.04, 0.04, 0.5, 6); rod.translate(0, 0.25, 0);
  const ball = new THREE.SphereGeometry(0.12, 8, 6); ball.translate(0, 0.5, 0);
  return mergeGeometries([rod, ball]);
}

function archShape(width, height, archW, archH, arches = 1) {
  const s = new THREE.Shape();
  s.moveTo(-width / 2, 0); s.lineTo(width / 2, 0); s.lineTo(width / 2, height); s.lineTo(-width / 2, height); s.closePath();
  const gap = width / arches;
  for (let i = 0; i < arches; i++) {
    const cx = -width / 2 + gap * (i + 0.5);
    const w = i === Math.floor(arches / 2) ? archW : archW * 0.55;
    const h = i === Math.floor(arches / 2) ? archH : archH * 0.65;
    const hole = new THREE.Path();
    hole.moveTo(cx - w / 2, 0);
    hole.lineTo(cx - w / 2, h - w / 2);
    hole.absarc(cx, h - w / 2, w / 2, Math.PI, 0, true);
    hole.lineTo(cx + w / 2, 0);
    hole.closePath();
    s.holes.push(hole);
  }
  return s;
}

function crenellations(width, depth, y, size = 1.0) {
  const parts = [];
  const n = Math.max(2, Math.floor(width / (size * 2)));
  for (let i = 0; i < n; i++) {
    const b = new THREE.BoxGeometry(size, size * 1.1, depth);
    b.translate(-width / 2 + size / 2 + i * size * 2 + (width - n * size * 2) / 2 + size / 2, y + size * 0.55, 0);
    parts.push(b);
  }
  return mergeGeometries(parts);
}

// ---- generators ---------------------------------------------------------------
function buildGate(lm) {
  const p = lm.params;
  const width = p.width || 12, height = p.height || 10, depth = 4.5;
  const archW = p.arch || 5, archH = Math.min(height - 1.5, archW * 1.5);
  const shape = archShape(width, height, archW, archH, p.arches || 1);
  const body = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  body.translate(0, 0, -depth / 2);
  const cren = crenellations(width, depth, height, 1.1);
  const geo = mergeGeometries([body, cren]);
  const mesh = new THREE.Mesh(geo, MAT.ochre);
  const heading = ((p.heading || 0) * Math.PI) / 180;
  mesh.rotation.y = Math.PI - heading;
  mesh.position.set(lm.center[0], lm.ground, lm.center[1]);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

function buildClockTower(lm) {
  const h = lm.params.height || 38;
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.4, h * 0.78, 4), MAT.gold.clone());
  shaft.material.color.set(0xc9b27a);
  shaft.rotation.y = Math.PI / 4;
  shaft.position.y = h * 0.39;
  g.add(shaft);
  const housing = new THREE.Mesh(new THREE.BoxGeometry(5.2, 5.2, 5.2), MAT.steel);
  housing.position.y = h * 0.78 + 2.6;
  g.add(housing);
  for (let i = 0; i < 4; i++) {
    const face = new THREE.Mesh(new THREE.CircleGeometry(2.1, 32), MAT.clockFace);
    const a = (i * Math.PI) / 2;
    face.position.set(Math.sin(a) * 2.62, housing.position.y, Math.cos(a) * 2.62);
    face.rotation.y = a;
    g.add(face);
  }
  const spire = new THREE.Mesh(new THREE.ConeGeometry(3.4, 5, 4), MAT.gold);
  spire.rotation.y = Math.PI / 4;
  spire.position.y = h * 0.78 + 5.2 + 2.5;
  g.add(spire);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 1.2, 32), MAT.stone);
  base.position.y = 0.6;
  g.add(base);
  g.position.set(lm.center[0], lm.ground, lm.center[1]);
  g.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  return g;
}

function buildInvertedPyramid(lm) {
  // Hotel du Lac (1973): ten storeys that widen with height along the long
  // axis, blank concrete gables at the two short ends, strip windows on the
  // long faces.
  // The OSM outline (layer=1) is the roof: the top floor spans it, the
  // ground floor is about 40% as long.
  const info = lm.footprint ? footprintInfo(lm.footprint) : null;
  const h = lm.params.height || 40;
  const L1 = info ? Math.max(info.w, info.h) * 1.1 : 100;
  const W = info ? Math.max(16, Math.min(info.w, info.h)) : 20;
  const L0 = L1 * 0.4;
  const angle = info ? info.angle : 0;
  const hw = W / 2;
  const v = [
    [-L0 / 2, 0, -hw], [L0 / 2, 0, -hw], [L0 / 2, 0, hw], [-L0 / 2, 0, hw],
    [-L1 / 2, h, -hw], [L1 / 2, h, -hw], [L1 / 2, h, hw], [-L1 / 2, h, hw],
  ];
  const quad = (a, b, c, d, pos, uv, scaleU) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    const lu = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * scaleU;
    const lv = Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
    uv.push(0, 0, lu, 0, lu, lv, 0, 0, lu, lv, 0, lv);
  };
  const group = new THREE.Group();
  // long faces: windows
  const lp = [], luv = [];
  quad(v[0], v[1], v[5], v[4], lp, luv, 1);
  quad(v[2], v[3], v[7], v[6], lp, luv, 1);
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  lg.setAttribute('uv', new THREE.Float32BufferAttribute(luv, 2));
  lg.computeVertexNormals();
  group.add(new THREE.Mesh(lg, new THREE.MeshStandardMaterial({ map: bandTexture(), roughness: 0.75 })));
  // gables + roof + underside: concrete
  const cp = [], cuv = [];
  quad(v[1], v[2], v[6], v[5], cp, cuv, 1);
  quad(v[3], v[0], v[4], v[7], cp, cuv, 1);
  quad(v[4], v[5], v[6], v[7], cp, cuv, 1);
  quad(v[3], v[2], v[1], v[0], cp, cuv, 1);
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
  cg.setAttribute('uv', new THREE.Float32BufferAttribute(cuv, 2));
  cg.computeVertexNormals();
  group.add(new THREE.Mesh(cg, new THREE.MeshStandardMaterial({ color: 0xa8998a, roughness: 0.9 })));
  // service core / podium
  const podium = new THREE.Mesh(new THREE.BoxGeometry(L0 * 1.1, 4, W * 1.3), MAT.concrete);
  podium.position.y = 2;
  group.add(podium);
  group.rotation.y = -angle;
  group.position.set(lm.center[0], lm.ground, lm.center[1]);
  group.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  return group;
}

let _band = null;
function bandTexture() {
  if (_band) return _band;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#b8a890'; ctx.fillRect(0, 0, 128, 128);
  // one storey per tile: spandrel below, ribbon window above
  ctx.fillStyle = '#3a4650'; ctx.fillRect(0, 14, 128, 56);
  ctx.fillStyle = 'rgba(255,255,255,0.18)'; for (let x = 0; x < 128; x += 16) ctx.fillRect(x, 14, 2, 56);
  ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.fillRect(0, 70, 128, 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / 6.4, 1 / 4); // 6.4 m bays, 4 m storeys
  t.colorSpace = THREE.SRGBColorSpace;
  _band = t;
  return t;
}

function buildCathedral(lm) {
  const g = new THREE.Group();
  if (!lm.footprint) return g;
  const info = footprintInfo(lm.footprint);
  const p = lm.params;
  const th = p.tower_h || 34;
  const roofY = lm.ground + (lm.osm_height || 20);
  const facade = p.facade || 'S';
  let corners;
  if (facade === 'S') corners = [cornerNearest(lm.footprint, info.minx, info.maxz), cornerNearest(lm.footprint, info.maxx, info.maxz)];
  else if (facade === 'N') corners = [cornerNearest(lm.footprint, info.minx, info.minz), cornerNearest(lm.footprint, info.maxx, info.minz)];
  else if (facade === 'W') corners = [cornerNearest(lm.footprint, info.minx, info.minz), cornerNearest(lm.footprint, info.minx, info.maxz)];
  else corners = [cornerNearest(lm.footprint, info.maxx, info.minz), cornerNearest(lm.footprint, info.maxx, info.maxz)];
  const mat = p.style === 'byzantine' ? MAT.white : MAT.ochre;
  for (const c of corners) {
    const tx = c[0] + Math.sign(info.cx - c[0]) * 3.5;
    const tz = c[1] + Math.sign(info.cz - c[1]) * 3.5;
    const tower = new THREE.Mesh(new THREE.BoxGeometry(7, th, 7), mat);
    tower.position.set(tx, lm.ground + th / 2, tz);
    g.add(tower);
    if (p.style === 'byzantine') {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(3.8, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), MAT.stone);
      cap.position.set(tx, lm.ground + th, tz);
      g.add(cap);
    } else {
      const cap = new THREE.Mesh(new THREE.ConeGeometry(4.6, 6, 4), MAT.stone);
      cap.rotation.y = Math.PI / 4;
      cap.position.set(tx, lm.ground + th + 3, tz);
      g.add(cap);
      const cross = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.5, 0.3), MAT.gold);
      cross.position.set(tx, lm.ground + th + 7, tz);
      g.add(cross);
    }
  }
  if (p.dome) {
    const r = Math.min(9, Math.max(info.w, info.h) * 0.14);
    const dome = new THREE.Mesh(domeGeo(), p.style === 'byzantine' ? MAT.stone : MAT.white);
    dome.scale.set(r, r, r);
    dome.position.set(info.cx, roofY, info.cz);
    g.add(dome);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.4, 3, 0.4), MAT.gold);
    fin.position.set(info.cx, roofY + r * 1.1 + 1.5, info.cz);
    g.add(fin);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  return g;
}

function buildLighthouse(lm) {
  const h = lm.params.height || 22;
  const g = new THREE.Group();
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3.0, h, 20), MAT.white);
  tower.position.y = h / 2;
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 0.4, 20), MAT.steel);
  gallery.position.y = h;
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 3, 12), MAT.darkGlass);
  lantern.position.y = h + 1.7;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(2.0, 1.6, 12), MAT.steel);
  cap.position.y = h + 4;
  g.add(tower, gallery, lantern, cap);
  g.position.set(lm.center[0], lm.ground, lm.center[1]);
  g.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  return g;
}

function buildKoubba(lm) {
  const g = new THREE.Group();
  const size = 9, h = 5.5;
  const slab = new THREE.Mesh(new THREE.BoxGeometry(size, 0.6, size), MAT.white);
  slab.position.y = h;
  g.add(slab);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, h, 10), MAT.white);
    col.position.set(sx * (size / 2 - 0.8), h / 2, sz * (size / 2 - 0.8));
    g.add(col);
  }
  const base = new THREE.Mesh(new THREE.BoxGeometry(size + 2, 0.8, size + 2), MAT.stone);
  base.position.y = 0.4;
  g.add(base);
  const dome = new THREE.Mesh(domeGeo(), MAT.white);
  dome.scale.setScalar(3.6);
  dome.position.y = h + 0.3;
  g.add(dome);
  g.position.set(lm.center[0], lm.ground, lm.center[1]);
  g.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  return g;
}

function buildObelisk(lm, h = 30) {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 2.2, h, 4), MAT.ochre);
  shaft.rotation.y = Math.PI / 4;
  shaft.position.y = h / 2 + 1;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(1.27, 2.2, 4), MAT.gold);
  tip.rotation.y = Math.PI / 4;
  tip.position.y = h + 2.1;
  const base = new THREE.Mesh(new THREE.BoxGeometry(6, 1, 6), MAT.stone);
  base.position.y = 0.5;
  g.add(shaft, tip, base);
  g.position.set(lm.center[0], lm.ground, lm.center[1]);
  g.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  return g;
}

function buildAmphitheatre(lm) {
  const g = new THREE.Group();
  const info = lm.footprint ? footprintInfo(lm.footprint) : { cx: lm.center[0], cz: lm.center[1], w: 120, h: 90, angle: 0 };
  const rx = info.w / 2, rz = info.h / 2;
  for (let i = 0; i < 5; i++) {
    const t = 1 - i * 0.14;
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1.4, 48, 1, true), MAT.roman);
    ring.scale.set(rx * t, 1, rz * t);
    ring.position.set(info.cx, lm.ground + i * 1.4 + 0.7, info.cz);
    ring.material = MAT.roman.clone();
    ring.material.side = THREE.DoubleSide;
    g.add(ring);
    const step = new THREE.Mesh(new THREE.RingGeometry(t - 0.14, t, 48), MAT.roman.clone());
    step.material.side = THREE.DoubleSide;
    step.rotation.x = -Math.PI / 2;
    step.scale.set(rx, rz, 1);
    step.position.set(info.cx, lm.ground + (i + 1) * 1.4 + 0.01, info.cz);
    g.add(step);
  }
  g.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
  return g;
}

function buildStadium(lm) {
  // Elliptical bowl around the real pitch (from OSM leisure=pitch when the
  // pipeline found one): stepped tiers rising outward, a concrete outer wall
  // and a roof ring.  Rades (60k seats) is large; El Menzah smaller.
  const g = new THREE.Group();
  const pitch = lm.pitch;
  const info = lm.footprint ? footprintInfo(lm.footprint) : null;
  const cx = pitch ? pitch.center[0] : (info ? info.cx : lm.center[0]);
  const cz = pitch ? pitch.center[1] : (info ? info.cz : lm.center[1]);
  const angle = pitch ? pitch.angle : (info ? info.angle : 0);
  const big = (lm.params && lm.params.height ? lm.params.height : 25) >= 30;
  const pl = pitch ? pitch.length : 105, pw = pitch ? pitch.width : 68;
  const innerA = pl / 2 + (big ? 22 : 12);   // half length of the bowl opening
  const innerB = pw / 2 + (big ? 20 : 10);
  const depth = big ? 62 : 38;                // horizontal extent of the tiers
  const height = big ? 34 : 20;
  const tiers = big ? 3 : 2;
  // profile in (radius factor, y) for a unit circle, lathe then scale to ellipse
  const profile = [];
  const rIn = 1.0;
  const rOut = 1.0 + depth / innerA;
  profile.push(new THREE.Vector2(rIn, 0));
  for (let t = 0; t < tiers; t++) {
    const r0 = rIn + ((rOut - rIn) * t) / tiers;
    const r1 = rIn + ((rOut - rIn) * (t + 0.85)) / tiers;
    const y0 = (height * t) / tiers;
    const y1 = (height * (t + 0.85)) / tiers;
    profile.push(new THREE.Vector2(r0, y0 + 1.0));            // parapet
    profile.push(new THREE.Vector2(r1, y1));                   // raked tier
    if (t < tiers - 1) profile.push(new THREE.Vector2(r1 + 0.01, y1 + 2.5)); // vomitory step
  }
  profile.push(new THREE.Vector2(rOut, height));
  profile.push(new THREE.Vector2(rOut + 0.02, height + 2.0)); // outer parapet
  profile.push(new THREE.Vector2(rOut + 0.02, 0));            // outer wall down to the ground
  const lathe = new THREE.LatheGeometry(profile, 96);
  const bowl = new THREE.Mesh(lathe, new THREE.MeshStandardMaterial({ color: 0xb9b3a8, roughness: 0.95, side: THREE.DoubleSide }));
  bowl.scale.set(innerA, 1, innerB);
  g.add(bowl);
  // seats: a second, slightly inset lathe tinted red/blue in sectors via vertex colours
  const seatGeo = new THREE.LatheGeometry(profile.slice(0, profile.length - 2), 96);
  const pos = seatGeo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const c1 = new THREE.Color(0xb4342c), c2 = new THREE.Color(0x2c4f9e), c3 = new THREE.Color(0xd8d2c4);
  for (let i = 0; i < pos.count; i++) {
    const a = Math.atan2(pos.getZ(i), pos.getX(i));
    const sector = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 12);
    const c = pos.getY(i) < 1.2 ? c3 : sector % 3 === 0 ? c2 : c1;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  seatGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const seats = new THREE.Mesh(seatGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  seats.scale.set(innerA * 1.002, 1, innerB * 1.002);
  seats.position.y = 0.15;
  g.add(seats);
  // roof ring: flat band over the upper tier, supported on slender columns
  const roofIn = rIn + (rOut - rIn) * 0.35;
  const roof = new THREE.Mesh(new THREE.RingGeometry(roofIn, rOut + 0.04, 96), new THREE.MeshStandardMaterial({ color: 0xdedbd3, roughness: 0.7, side: THREE.DoubleSide }));
  roof.rotation.x = -Math.PI / 2;
  roof.scale.set(innerA, innerB, 1);
  roof.position.y = height + 7;
  g.add(roof);
  const colGeo = new THREE.CylinderGeometry(0.6, 0.6, 9, 8);
  const cols = new THREE.InstancedMesh(colGeo, MAT.concrete, 48);
  const d = new THREE.Object3D();
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    d.position.set(Math.cos(a) * innerA * (rOut - 0.02), height + 2.5, Math.sin(a) * innerB * (rOut - 0.02));
    d.updateMatrix();
    cols.setMatrixAt(i, d.matrix);
  }
  g.add(cols);
  // the real pitch and track stay visible through the opening (imagery)
  g.rotation.y = -angle;
  g.position.set(cx, lm.ground, cz);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

// ---- main class -----------------------------------------------------------------
export class Landmarks {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'landmarks';
    scene.add(this.group);
    this.list = [];
    this.instances = {
      sqMinaret: [], sqRoof: [], octMinaret: [], octRoof: [], dome: [], finial: [],
      domeGreen: [], merlon: [],
    };
  }

  async init(url = '/data/landmarks.json') {
    const data = await fetch(url).then((r) => r.json());
    this.data = data;
    this.list = data.landmarks;
    this.places = data.places || [];
    const minaretNodes = data.features.filter((f) => f.kind === 'minaret');
    const handled = new Set();

    for (const lm of data.landmarks) {
      if (lm.osm) handled.add(lm.osm);
      this.buildCurated(lm, minaretNodes);
    }
    const curatedPts = data.landmarks.map((l) => l.center);
    const nearCurated = (f, r) => curatedPts.some((c) => Math.hypot(c[0] - f.center[0], c[1] - f.center[1]) < r);
    for (const f of data.features) {
      if (handled.has(f.osm)) continue;
      if ((f.kind === 'tower' || f.kind === 'minaret') && nearCurated(f, 45)) continue;
      switch (f.kind) {
        case 'mosque':
          if (f.footprint) this.decorateMosque(f, {}, minaretNodes);
          break;
        case 'minaret':
          this.addMinaret(f.center[0], f.ground, f.center[1], f.height || 22, 'square', 3.2, MAT.white.color);
          break;
        case 'tower':
          this.buildTower(f);
          break;
        case 'aqueduct':
          this.buildAqueduct(f);
          break;
        case 'city_wall':
          this.buildCityWall(f);
          break;
        default:
          break;
      }
    }
    this.flushInstances();
    console.log(`landmarks: ${data.landmarks.length} curated, ${data.features.length} features`);
  }

  buildCurated(lm, minaretNodes) {
    let obj = null;
    switch (lm.kind) {
      case 'mosque':
        if (lm.footprint) this.decorateMosque(lm, lm.params, minaretNodes, true);
        break;
      case 'gate': obj = buildGate(lm); break;
      case 'clock_tower': obj = buildClockTower(lm); break;
      case 'inverted_pyramid': obj = buildInvertedPyramid(lm); break;
      case 'cathedral': obj = buildCathedral(lm); break;
      case 'lighthouse': obj = buildLighthouse(lm); break;
      case 'koubba': obj = buildKoubba(lm); break;
      case 'obelisk': obj = buildObelisk(lm, lm.params.height || 30); break;
      case 'amphitheatre': obj = buildAmphitheatre(lm); break;
      case 'stadium': if (lm.matched === 'area') obj = buildStadium(lm); break;
      case 'mausoleum':
        if (lm.footprint) {
          const info = footprintInfo(lm.footprint);
          const top = lm.ground + (lm.osm_height || 9);
          const n = 3;
          for (let i = 0; i < n; i++) {
            const t = (i + 0.5) / n - 0.5;
            const x = info.cx + Math.cos(info.angle) * t * info.w * 0.7;
            const z = info.cz + Math.sin(info.angle) * t * info.h * 0.7;
            this.instances.domeGreen.push([x, top, z, 3.4]);
            this.instances.finial.push([x, top + 3.4 * 1.1, z, 1.5]);
          }
        }
        break;
      case 'palace':
      case 'civic':
        if (lm.footprint && (lm.params.dome || lm.params.domes)) {
          const info = footprintInfo(lm.footprint);
          const top = lm.ground + (lm.osm_height || lm.params.height || 14);
          const r = lm.params.domes === 'small' ? 3 : 8;
          this.instances.dome.push([info.cx, top, info.cz, r]);
          this.instances.finial.push([info.cx, top + r * 1.1, info.cz, 1.2]);
          if (lm.params.tower_h) {
            const tower = new THREE.Mesh(new THREE.BoxGeometry(14, lm.params.tower_h, 14), MAT.stone);
            tower.position.set(info.cx + info.w * 0.3, lm.ground + lm.params.tower_h / 2, info.cz);
            tower.castShadow = true;
            this.group.add(tower);
          }
        }
        break;
      default:
        break;
    }
    if (obj) this.group.add(obj);
  }

  decorateMosque(f, params, minaretNodes, curated = false) {
    const fp = f.footprint;
    const info = footprintInfo(fp);
    const area = f.area || info.w * info.h * 0.7;
    const top = f.top !== undefined ? f.top : f.ground + (f.osm_height || 8);
    const ground = f.ground;
    // Minaret: use a mapped man_made=minaret node if one sits at this mosque.
    const nearNode = minaretNodes.find((m) => Math.hypot(m.center[0] - info.cx, m.center[1] - info.cz) < Math.max(info.w, info.h) * 0.75 + 15);
    const style = params.minaret || 'square';
    const mh = params.minaret_h || THREE.MathUtils.clamp(Math.sqrt(area) * 0.85, 15, 32);
    const baseW = style === 'square' ? THREE.MathUtils.clamp(mh * 0.14, 2.6, 6.5) : THREE.MathUtils.clamp(mh * 0.13, 2.4, 4.5);
    const colour = (curated && (f.id === 'zitouna' || f.id === 'kasbah_mosque')) ? MAT.ochre.color : MAT.white.color;
    if (nearNode) {
      nearNode._used = true;
      this.addMinaret(nearNode.center[0], ground, nearNode.center[1], nearNode.height || mh, style, baseW, colour);
    } else if (area > 120) {
      // North-west corner by convention (true for the Zitouna).
      const corner = cornerNearest(fp, info.minx, info.minz);
      const x = corner[0] + Math.sign(info.cx - corner[0]) * baseW * 0.55;
      const z = corner[1] + Math.sign(info.cz - corner[1]) * baseW * 0.55;
      this.addMinaret(x, ground, z, mh, style, baseW, colour);
    }
    // Domes
    const domes = params.domes || (area > 250 ? 'single' : null);
    if (domes === 'ottoman') {
      const r = THREE.MathUtils.clamp(Math.sqrt(area) * 0.16, 5, 11);
      this.instances.dome.push([info.cx, top, info.cz, r]);
      this.instances.finial.push([info.cx, top + r * 1.1, info.cz, 1.5]);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        this.instances.dome.push([info.cx + dx * r * 1.05, top - 1.5, info.cz + dz * r * 1.05, r * 0.55]);
      }
      for (const [dx, dz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        this.instances.dome.push([info.cx + dx * r * 1.0, top - 2.5, info.cz + dz * r * 1.0, r * 0.35]);
      }
    } else if (domes === 'large') {
      const r = THREE.MathUtils.clamp(Math.sqrt(area) * 0.18, 8, 16);
      this.instances.dome.push([info.cx, top, info.cz, r]);
      this.instances.finial.push([info.cx, top + r * 1.1, info.cz, 2.5]);
    } else if (domes === 'small') {
      const r = 3.0;
      // over the mihrab: opposite corner to the minaret, slightly inset
      const x = info.cx + (info.maxx - info.cx) * 0.45;
      const z = info.cz + (info.maxz - info.cz) * 0.45;
      this.instances.dome.push([x, top, z, r]);
      this.instances.finial.push([x, top + r * 1.1, z, 1.0]);
    } else if (domes === 'single') {
      const r = THREE.MathUtils.clamp(Math.sqrt(area) * 0.11, 2.5, 7);
      this.instances.dome.push([info.cx, top, info.cz, r]);
      this.instances.finial.push([info.cx, top + r * 1.1, info.cz, 1.0]);
    }
  }

  addMinaret(x, y, z, h, style, baseW, colour) {
    const c = colour || MAT.white.color;
    if (style === 'octagonal') {
      this.instances.octMinaret.push([x, y, z, h, baseW, c]);
      this.instances.octRoof.push([x, y, z, h, baseW, c]);
    } else {
      this.instances.sqMinaret.push([x, y, z, h, baseW, c]);
      this.instances.sqRoof.push([x, y, z, h, baseW, c]);
    }
  }

  buildTower(f) {
    const t = f.tags || {};
    const kind = t.man_made;
    let h = f.height || 0;
    if (h > 260) h = 0;
    let mesh;
    if (t['tower:type'] === 'minaret' || kind === 'minaret') {
      this.addMinaret(f.center[0], f.ground, f.center[1], h || 22, 'square', 3.2, MAT.white.color);
      return;
    }
    if (kind === 'lighthouse') {
      // OSM often carries the focal height above sea level in `height`.
      if (h > 45 || h < 6) h = 0;
      mesh = buildLighthouse({ center: f.center, ground: f.ground, params: { height: h || 18 } });
    } else if (kind === 'water_tower') {
      h = h || 25;
      const g = new THREE.Group();
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, h * 0.7, 12), MAT.concrete);
      stem.position.y = h * 0.35;
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(6, 4.5, h * 0.3, 16), MAT.concrete);
      tank.position.y = h * 0.85;
      g.add(stem, tank);
      g.position.set(f.center[0], f.ground, f.center[1]);
      mesh = g;
    } else if (kind === 'chimney') {
      h = h || 35;
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2.2, h, 12), MAT.brick);
      mesh.position.set(f.center[0], f.ground + h / 2, f.center[1]);
    } else if (kind === 'communications_tower' || kind === 'mast' || t['tower:type'] === 'communication') {
      h = h || (kind === 'mast' ? 30 : 60);
      const g = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.6, h, 8), MAT.redWhite);
      shaft.position.y = h / 2;
      const dishes = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 1.2, 10), MAT.steel);
      dishes.position.y = h * 0.8;
      g.add(shaft, dishes);
      g.position.set(f.center[0], f.ground, f.center[1]);
      mesh = g;
    } else if (kind === 'obelisk' || kind === 'monument') {
      mesh = buildObelisk({ center: f.center, ground: f.ground }, h || 10);
    } else {
      h = h || 18;
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.8, h, 10), MAT.stone);
      mesh.position.set(f.center[0], f.ground + h / 2, f.center[1]);
    }
    mesh.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
    this.group.add(mesh);
  }

  buildCityWall(f) {
    if (!f.line || f.line.length < 2) return;
    const h = f.height || 7;
    const thick = 1.4;
    const parts = [];
    for (let i = 0; i < f.line.length - 1; i++) {
      const [x0, z0, g0] = f.line[i];
      const [x1, z1, g1] = f.line[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.5) continue;
      const ang = Math.atan2(z1 - z0, x1 - x0);
      const gmin = Math.min(g0, g1) - 0.5;
      const top = Math.max(g0, g1) + h;
      const seg = new THREE.BoxGeometry(len + thick, top - gmin, thick);
      seg.translate(0, (top - gmin) / 2 + gmin, 0);
      seg.rotateY(-ang);
      seg.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
      parts.push(seg);
      const n = Math.floor(len / 2.2);
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        this.instances.merlon.push([x0 + (x1 - x0) * t, top, z0 + (z1 - z0) * t, ang]);
      }
    }
    if (!parts.length) return;
    const mesh = new THREE.Mesh(mergeGeometries(parts), MAT.ochre);
    mesh.castShadow = mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  buildAqueduct(f) {
    if (!f.line || f.line.length < 2) return;
    const h = f.height || 12;
    const parts = [];
    for (let i = 0; i < f.line.length - 1; i++) {
      const [x0, z0, g0] = f.line[i];
      const [x1, z1, g1] = f.line[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 3) continue;
      const arches = Math.max(1, Math.floor(len / 6.2));
      const shape = new THREE.Shape();
      shape.moveTo(-len / 2, 0); shape.lineTo(len / 2, 0); shape.lineTo(len / 2, h); shape.lineTo(-len / 2, h); shape.closePath();
      const span = len / arches;
      for (let a = 0; a < arches; a++) {
        const cx = -len / 2 + span * (a + 0.5);
        const w = span * 0.62;
        const ah = h * 0.72;
        const hole = new THREE.Path();
        hole.moveTo(cx - w / 2, 0); hole.lineTo(cx - w / 2, ah - w / 2);
        hole.absarc(cx, ah - w / 2, w / 2, Math.PI, 0, true);
        hole.lineTo(cx + w / 2, 0); hole.closePath();
        shape.holes.push(hole);
      }
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 2.4, bevelEnabled: false });
      geo.translate(0, 0, -1.2);
      const ang = Math.atan2(z1 - z0, x1 - x0);
      geo.rotateY(-ang);
      geo.translate((x0 + x1) / 2, Math.min(g0, g1) - 0.5, (z0 + z1) / 2);
      parts.push(geo);
    }
    if (!parts.length) return;
    const mesh = new THREE.Mesh(mergeGeometries(parts), MAT.roman);
    mesh.castShadow = mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  flushInstances() {
    const dummy = new THREE.Object3D();
    const make = (geo, mat, items, place, withColour = false) => {
      if (!items.length) return;
      const m = new THREE.InstancedMesh(geo, mat, items.length);
      items.forEach((it, i) => {
        place(dummy, it);
        dummy.updateMatrix();
        m.setMatrixAt(i, dummy.matrix);
        if (withColour) m.setColorAt(i, it[5]);
      });
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.castShadow = m.receiveShadow = true;
      m.frustumCulled = false;
      this.group.add(m);
    };
    const placeMinaret = (d, it) => {
      d.position.set(it[0], it[1], it[2]);
      d.scale.set(it[4], it[3], it[4]);
      d.rotation.set(0, 0, 0);
    };
    const whiteInst = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
    make(squareMinaretGeo(), whiteInst, this.instances.sqMinaret, placeMinaret, true);
    make(squareMinaretRoofGeo(), MAT.greenTile, this.instances.sqRoof, placeMinaret);
    make(octMinaretGeo(), whiteInst, this.instances.octMinaret, placeMinaret, true);
    make(octMinaretRoofGeo(), MAT.greenTile, this.instances.octRoof, placeMinaret);
    const placeDome = (d, it) => {
      d.position.set(it[0], it[1], it[2]);
      d.scale.setScalar(it[3]);
      d.rotation.set(0, 0, 0);
    };
    make(domeGeo(), MAT.white, this.instances.dome, placeDome);
    make(domeGeo(), MAT.greenTile, this.instances.domeGreen, placeDome);
    make(finialGeo(), MAT.gold, this.instances.finial, placeDome);
    make(new THREE.BoxGeometry(1.1, 1.0, 1.6), MAT.ochre, this.instances.merlon, (d, it) => {
      d.position.set(it[0], it[1] + 0.5, it[2]);
      d.scale.set(1, 1, 1);
      d.rotation.set(0, -it[3], 0);
    });
  }
}
